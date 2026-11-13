/** Bounded, pane-verified live model changes. Menus are always dismissed before
 * returning, including listings and fallback questions (which store snapshots). */
import { codexScreen } from './codex.js';
import { classifyStartup } from './launcher.js';
import { parseDialogPane } from './question.js';
import type { Tmux } from './tmux.js';

export interface ModelOption { number: number; label: string; model: string; cursor?: boolean }
export interface ModelMenu { kind: 'models' | 'reasoning' | 'confirm'; options: ModelOption[]; more: boolean }

/** Codex deliberately mixes spaces and dashes in display names. */
export const normalizeModel = (s: string) => s.toLowerCase().replace(/[\s-]+/g, '');
const claudeKey = (s: string) => normalizeModel(s.replace(/^claude-/i, '').replace(/\./g, '-'));
const sameModel = (a: string, b: string, engine: string) => engine === 'codex'
  ? normalizeModel(a) === normalizeModel(b) : claudeKey(a) === claudeKey(b);

function displayId(label: string, engine: string): string {
  const clean = label.replace(/\s*\([^)]*\)/g, '').trim();
  return engine === 'codex' ? clean.toLowerCase().replace(/[\s-]+/g, '-')
    : `claude-${clean.toLowerCase().replace(/^claude[ -]/, '').replace(/[\s.]+/g, '-')}`;
}

export function parseModelMenu(pane: string, engine: 'claude' | 'codex'): ModelMenu | undefined {
  const heading = engine === 'codex' ? /Select Model and Effort|Select Reasoning Level[^\n]*/g
    : /Switch model\?|Select model|Select a model/i;
  const matches = [...pane.matchAll(engine === 'codex' ? heading : new RegExp(heading.source, 'gi'))];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return undefined;
  const block = pane.slice(last.index);
  const kind = /^Switch model\?/.test(block) ? 'confirm' : /^Select Reasoning Level/.test(block) ? 'reasoning' : 'models';
  const options: ModelOption[] = [];
  for (const line of block.split('\n').slice(1)) {
    const m = line.match(/^\s*([›❯]\s*)?(\d+)\.\s+(.+?)\s*$/);
    if (!m) continue;
    // Two or more spaces separate a display label from its prose description.
    const label = m[3].split(/\s{2,}/)[0].trim();
    options.push({ number: Number(m[2]), label, model: displayId(label, engine), cursor: !!m[1] });
  }
  return options.length ? { kind, options, more: /^\s*↓\s*$/m.test(block) } : undefined;
}

export function reasoningKeys(menu: ModelMenu, effort?: string): string[] | undefined {
  const key = (s: string) => s.toLowerCase().replace(/\s*\([^)]*\)/g, '').replace(/extra high/, 'xhigh').replace(/\s+/g, '');
  const current = menu.options.findIndex(o => o.cursor);
  const wanted = !effort || effort === 'default'
    ? menu.options.findIndex(o => /\(default\)/i.test(o.label))
    : menu.options.findIndex(o => key(o.label) === effort);
  const target = wanted < 0 && (!effort || effort === 'default') ? current : wanted;
  if (current < 0 || target < 0) return undefined;
  return [...Array<string>(Math.abs(target - current)).fill(target < current ? 'Up' : 'Down'), 's'];
}

export type SwitchResult = { kind: 'switched'; model: string; effort?: string } |
  { kind: 'menu'; menu: ModelMenu };

export class LiveModelSwitcher {
  constructor(private tmux: Tmux, private pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms))) {}

  private async wait(session: string, accepts: (pane: string) => boolean): Promise<string> {
    for (let i = 0; i < 12; i++) {
      await this.pause(200);
      const pane = await this.tmux.capturePane(session);
      if (accepts(pane)) return pane;
    }
    throw new Error('unexpected model screen or confirmation timed out; old registry model kept — inspect with `peek`');
  }

  async run(session: string, engine: 'claude' | 'codex', model?: string, effort?: string): Promise<SwitchResult> {
    let opened = false;
    let applied = false;
    try {
      const before = await this.tmux.capturePane(session);
      if (parseModelMenu(before, engine) || parseDialogPane(before).kind !== 'none') {
        opened = true;
        throw new Error('a dialog was already on screen; cancelled it, retry from the idle prompt');
      }
      if ((engine === 'codex' ? codexScreen(before) : classifyStartup(before)) !== 'ready') {
        opened = true;
        throw new Error('hand is not at a recognised idle prompt; cancelled the unexpected screen without typing a command');
      }
      if (engine === 'claude' && effort !== undefined) {
        throw new Error('live Claude effort changes are not supported; stop and spawn with effort= instead');
      }
      opened = true;
      await this.tmux.sendText(session, engine === 'claude' && model ? `/model ${model}` : '/model');
      await this.tmux.sendKeys(session, 'Enter');
      const freshClaude = (p: string) => !!model && this.claudeConfirmed(p, model) && this.confirmations(p, 'claude', model) > this.confirmations(before, 'claude', model);
      let pane = await this.wait(session, p => !!parseModelMenu(p, engine) || (engine === 'claude' && freshClaude(p)));
      if (engine === 'claude' && model && freshClaude(pane)) {
        applied = true;
        return { kind: 'switched', model };
      }
      let menu = parseModelMenu(pane, engine)!;
      if (!model) return { kind: 'menu', menu };
      if (engine === 'claude') {
        if (menu.kind === 'models') return { kind: 'menu', menu };
        if (menu.kind !== 'confirm') throw new Error('expected Claude “Switch model?” confirmation');
        const yes = menu.options.find(o => /^Yes, switch to /i.test(o.label) && sameModel(o.label.replace(/^Yes, switch to /i, ''), model, engine));
        if (!yes) throw new Error('Claude confirmation did not name the requested model');
        await this.tmux.sendKeys(session, String(yes.number));
        await this.wait(session, p => freshClaude(p));
        applied = true;
        return { kind: 'switched', model };
      }
      if (menu.kind !== 'models') throw new Error('expected Codex model list');
      const option = menu.options.find(o => sameModel(o.model, model, engine));
      if (!option) return { kind: 'menu', menu };
      await this.tmux.sendKeys(session, String(option.number));
      pane = await this.wait(session, p => parseModelMenu(p, engine)?.kind === 'reasoning');
      menu = parseModelMenu(pane, engine)!;
      const heading = pane.match(/Select Reasoning Level for ([^\n]+)/g)?.at(-1)?.replace('Select Reasoning Level for ', '').trim();
      if (!heading || !sameModel(heading, model, engine)) throw new Error('Codex reasoning screen names a different model');
      let keys = reasoningKeys(menu, effort);
      if (!keys && ['max', 'ultra'].includes(effort ?? '')) {
        const more = menu.options.find(o => /^More reasoning/i.test(o.label));
        const cursor = menu.options.findIndex(o => o.cursor);
        const target = menu.options.indexOf(more!);
        if (more && cursor >= 0) {
          await this.tmux.sendKeys(session, ...Array<string>(Math.abs(target - cursor)).fill(target < cursor ? 'Up' : 'Down'), 'Enter');
          pane = await this.wait(session, p => {
            const m = parseModelMenu(p, engine);
            return !!m && m.kind === 'reasoning' && !!reasoningKeys(m, effort) &&
              !!p.match(/Select Reasoning Level for ([^\n]+)/g)?.at(-1)?.includes(heading);
          });
          menu = parseModelMenu(pane, engine)!;
          keys = reasoningKeys(menu, effort);
        }
      }
      if (!keys) throw new Error(`reasoning level ${effort ?? 'default'} is not on screen`);
      // Arrows, not digits: digits can select globally. `s` is session-only.
      await this.tmux.sendKeys(session, ...keys);
      const confirmed = await this.wait(session, p => !parseModelMenu(p, engine) && this.codexConfirmed(p, model, effort) && this.confirmations(p, 'codex', model, effort) > this.confirmations(before, 'codex', model, effort));
      const actual = this.codexConfirmation(confirmed)!;
      applied = true;
      return { kind: 'switched', model, effort: actual.effort };
    } finally {
      if (opened && !applied) {
        // Codex can be nested two levels deep. Esc twice unwinds both, without
        // submitting input or changing config.toml. Failure propagates, not success.
        await this.tmux.sendKeys(session, 'Escape');
        if (engine === 'codex') await this.tmux.sendKeys(session, 'Escape');
        for (let i = 0; i < 3; i++) {
          await this.pause(200);
          if (!parseModelMenu(await this.tmux.capturePane(session), engine)) break;
          if (i === 2) throw new Error('could not dismiss the model menu; inspect with `peek` or `press <hand> esc`');
          await this.tmux.sendKeys(session, 'Escape');
        }
      }
    }
  }

  private confirmations(pane: string, engine: string, model: string, effort?: string): number {
    if (engine === 'claude') return [...pane.matchAll(/Set model to (.+?)(?: and saved|\s*$)/gm)]
      .filter(m => sameModel(m[1], model, engine)).length;
    return [...pane.matchAll(/Model changed to (\S+) (\w+) for this session only/g)]
      .filter(m => sameModel(m[1], model, engine) && (!effort || effort === 'default' || m[2] === effort)).length;
  }

  private claudeConfirmed(pane: string, model: string): boolean {
    if (parseModelMenu(pane, 'claude')) return false;
    const label = [...pane.matchAll(/Set model to (.+?)(?: and saved|\s*$)/gm)].at(-1)?.[1];
    return !!label && sameModel(label, model, 'claude');
  }
  private codexConfirmation(pane: string): { model: string; effort: string } | undefined {
    const m = [...pane.matchAll(/Model changed to (\S+) (\w+) for this session only/g)].at(-1);
    return m ? { model: m[1], effort: m[2] } : undefined;
  }
  private codexConfirmed(pane: string, model: string, effort?: string): boolean {
    const c = this.codexConfirmation(pane);
    return !!c && sameModel(c.model, model, 'codex') && (!effort || effort === 'default' || c.effort === effort);
  }
}
