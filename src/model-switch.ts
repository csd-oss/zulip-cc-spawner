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
  let descriptionColumn: number | undefined;
  for (const line of block.split('\n').slice(1)) {
    const m = line.match(/^\s*([↑↓›❯\s]*?)(\d+)\.\s+(.+?)\s*$/);
    if (!m) continue;
    // Even a numbered continuation belongs to the description, not the menu.
    if (engine === 'claude' && descriptionColumn !== undefined && line.indexOf(m[2]) >= descriptionColumn) continue;
    // Two or more spaces separate a display label from its prose description.
    const [label, description] = m[3].split(/\s{2,}/);
    if (description) descriptionColumn = line.indexOf(description, line.indexOf(m[3]) + label.length);
    // 2.1.323 labels are families (and may carry ✔); the version lives in
    // the description column, rather than in wrapped continuation lines.
    const versioned = engine === 'claude' && description?.match(/^((?:Claude[ -])?[a-z][a-z -]* \d+(?:\.\d+)*)(?=\s*(?:·|$))/i)?.[1];
    const identity = engine === 'claude' ? versioned || label.replace(/\s*✔/g, '').trim() : label;
    options.push({ number: Number(m[2]), label: label.trim(), model: displayId(identity, engine), cursor: /[›❯]/.test(m[1]) });
  }
  return options.length ? { kind, options, more: /^\s*(?:[›❯]\s*)?↓(?:\s|$)|^\s*…\s*\+\d+\s+models?\b/m.test(block) } : undefined;
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

  private async wait(session: string, accepts: (pane: string) => boolean, phase = 'confirmation'): Promise<string> {
    for (let i = 0; i < 12; i++) {
      await this.pause(200);
      const pane = await this.tmux.capturePane(session);
      if (accepts(pane)) return pane;
    }
    throw new Error(`unexpected model screen or ${phase} timed out; old registry model kept — inspect with \`peek\``);
  }

  /** Walk Claude's viewport, never select it. Stop at verified endpoints and
   * refuse incomplete/inconsistent snapshots rather than guessing hidden ids. */
  private async claudeModels(session: string, initial: ModelMenu): Promise<ModelMenu> {
    if (!initial.more && Math.min(...initial.options.map(o => o.number)) === 1) {
      // A cursor on the last visible row can hide a ↓-only indicator.
      // With no prior viewport evidence, report uncertainty, not completeness.
      return { ...initial, more: initial.options.at(-1)?.cursor === true };
    }
    const options = new Map<number, ModelOption>();
    const originalCursor = initial.options.find(o => o.cursor)?.number;
    let menu = initial;
    let moves = 0;
    let requiredBottom = 1;
    const merge = () => {
      // Remember evidence of hidden rows even if ↓ is replaced by the cursor
      // on a subsequent screen. A disappearing marker is not an endpoint.
      if (menu.more) requiredBottom = Math.max(requiredBottom, Math.max(...menu.options.map(o => o.number)) + 1);
      for (const option of menu.options) {
        const previous = options.get(option.number);
        if (previous && previous.model !== option.model) throw new Error('Claude model menu changed while scrolling; retry');
        options.set(option.number, { ...option, cursor: option.number === originalCursor });
      }
    };
    const cursor = () => {
      const option = menu.options.find(o => o.cursor);
      if (!option) throw new Error('Claude scrolling model menu has no cursor; old model kept');
      return option.number;
    };
    const step = async (key: 'Up' | 'Down') => {
      if (++moves > 64) throw new Error('Claude model menu discovery exceeded 64 moves; old model kept');
      const expected = cursor() + (key === 'Up' ? -1 : 1);
      await this.tmux.sendKeys(session, key);
      const pane = await this.wait(session, p => {
        const next = parseModelMenu(p, 'claude');
        return next?.kind === 'models' && next.options.some(o => o.cursor && o.number === expected);
      }, 'Claude model menu discovery');
      menu = parseModelMenu(pane, 'claude')!;
      merge();
    };
    merge();
    while (cursor() > 1) await step('Up');
    while (menu.more || cursor() < Math.max(requiredBottom, ...menu.options.map(o => o.number))) await step('Down');
    const sorted = [...options.values()].sort((a, b) => a.number - b.number);
    if (sorted.some((o, i) => o.number !== i + 1)) throw new Error('Claude model menu discovery missed entries; retry');
    return { kind: 'models', options: sorted, more: false };
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
      let pane = await this.wait(session, p => !!parseModelMenu(p, engine) || (engine === 'claude' && freshClaude(p)), 'model menu opening');
      if (engine === 'claude' && model && freshClaude(pane)) {
        applied = true;
        return { kind: 'switched', model };
      }
      let menu = parseModelMenu(pane, engine)!;
      if (engine === 'claude' && menu.kind === 'models') menu = await this.claudeModels(session, menu);
      if (!model) return { kind: 'menu', menu };
      if (engine === 'claude') {
        if (menu.kind === 'models') return { kind: 'menu', menu };
        if (menu.kind !== 'confirm') throw new Error('expected Claude “Switch model?” confirmation');
        const yes = menu.options.find(o => /^Yes, switch to /i.test(o.label) && sameModel(o.label.replace(/^Yes, switch to /i, ''), model, engine));
        if (!yes) throw new Error('Claude confirmation did not name the requested model');
        // Keep the captured /model <id> -> Yes flow. The list advertises `s`,
        // but no captured session-only confirmation establishes its safety.
        // This path may save Claude's default; launches still pass --model.
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
