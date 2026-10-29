/**
 * TranscriptWatcher (ported from cc-spawner) — surfaces a hand's invisible
 * session events in its home topic:
 *
 *  - `model_refusal_fallback` / `model_consent_fallback`: Claude Code silently
 *    switched the session to a fallback model (observed sticky).
 *  - `compact_boundary`: the context was compacted.
 *  - any change of the answering model.
 *  - open AskUserQuestion dialogs / permission prompts, detected from the tmux
 *    pane (an open dialog leaves no transcript trace; the tool_use/tool_result
 *    pair lands only on resolution), posted and resolved here.
 *
 * Transcripts are append-only JSONL, read from a persisted BYTE OFFSET through
 * the AgentHost (they belong to the agents user). Only complete lines advance
 * the offset.
 */
import { join } from 'node:path';
import type { AgentHost } from './host.js';
import type { Notifier } from './notifier.js';
import { dialogSig, formatQuestionPost, parseDialogPane, type PaneDialog, type PendingQuestion } from './question.js';
import type { BotEntry, Registry } from './registry.js';
import type { Tmux } from './tmux.js';

const log = (msg: string) => console.log(`${new Date().toISOString()} [transcript] ${msg}`);

/** ~/.claude/projects/<slug>/<id>.jsonl, slug = cwd with every non-alphanumeric
 *  replaced by '-' (Claude Code's project dir naming). */
export function transcriptPath(agentsHome: string, projectDir: string, sessionId: string): string {
  const slug = projectDir.replace(/[^A-Za-z0-9]/g, '-');
  return join(agentsHome, '.claude', 'projects', slug, `${sessionId}.jsonl`);
}

const isPermission = (entry: BotEntry): boolean => entry.pendingQuestion?.questions[0]?.kind === 'permission';

const fmtTokens = (n: unknown): string =>
  typeof n === 'number' ? (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)) : '?';

/** How long a fallback event waits for the fallback model's first reply. */
const FALLBACK_MODEL_WAIT_MS = 2 * 60_000;

interface PendingFallback {
  kind: 'refusal' | 'consent';
  seenAt: number;
}

export class TranscriptWatcher {
  private readonly pending = new Map<string, PendingFallback>();
  /** AskUserQuestion tool_use ids seen per hand — the matching tool_result is the resolution. */
  private readonly questionUses = new Map<string, Set<string>>();

  constructor(
    private readonly registry: Registry,
    private readonly host: AgentHost,
    private readonly tmux: Tmux,
    private readonly notifier: Notifier,
    private readonly paths: { agentsHome: string; projectDir: string },
    private readonly spawnerName: () => string,
  ) {}

  transcriptPath(sessionId: string): string {
    return transcriptPath(this.paths.agentsHome, this.paths.projectDir, sessionId);
  }

  async sweep(): Promise<void> {
    for (const entry of this.registry.alive()) {
      try {
        await this.check(entry);
      } catch (err) {
        log(`sweep error for ${entry.personaName}: ${(err as Error).message}`);
      }
      try {
        await this.checkDialog(entry);
      } catch (err) {
        log(`dialog sweep error for ${entry.personaName}: ${(err as Error).message}`);
      }
    }
  }

  private async checkDialog(entry: BotEntry): Promise<void> {
    const pane = await this.tmux.capturePane(entry.tmuxSession).catch(() => '');
    if (!pane) return;
    const dialog = parseDialogPane(pane);
    if (dialog.kind === 'review') {
      // Only auto-confirm reviews of dialogs we drove from Zulip.
      if (entry.pendingQuestion) {
        log(`${entry.personaName}: dialog on review screen — confirming submit`);
        await this.tmux.sendKeys(entry.tmuxSession, '1').catch(() => undefined);
      }
      return;
    }
    if (dialog.kind === 'question') {
      const sig = dialogSig(dialog.q);
      if (entry.pendingQuestion?.sig === sig) {
        // Posted already — unless the post failed: retry it every sweep.
        if (entry.pendingQuestion.messageId === undefined) await this.announceQuestion(entry, dialog);
        return;
      }
      if (isPermission(entry)) await this.resolvePermission(entry);
      await this.announceQuestion(entry, dialog);
      return;
    }
    // Permission prompts leave no marker we can key on: the dialog vanishing IS the resolution.
    if (isPermission(entry)) await this.resolvePermission(entry);
  }

  private async resolvePermission(entry: BotEntry): Promise<void> {
    const pending = entry.pendingQuestion;
    if (!pending) return;
    const q = pending.questions[0];
    const how = pending.answeredWith ? `**${pending.answeredWith}** sent from Zulip` : 'answered in the terminal';
    const denied = /^(no|deny|reject|esc)/i.test(pending.answeredWith ?? '');
    const icon = pending.answeredWith ? (denied ? '🚫' : '✅') : 'ℹ️';
    await this.post(entry, `${icon} **${entry.personaName}**'s permission prompt (${q.title ?? 'tool use'}) is resolved — ${how}.`);
    this.registry.update(entry, { pendingQuestion: undefined });
  }

  private async check(entry: BotEntry): Promise<void> {
    const path = this.transcriptPath(entry.sessionId);
    const size = await this.host.size(path);
    if (size === undefined) return;

    if (entry.transcriptOffset === undefined) {
      this.registry.update(entry, { transcriptOffset: size });
      return;
    }
    if (size < entry.transcriptOffset) {
      log(`${entry.personaName}: transcript shrank (${entry.transcriptOffset} → ${size}) — resyncing to EOF`);
      this.registry.update(entry, { transcriptOffset: size });
      return;
    }
    if (size === entry.transcriptOffset) {
      await this.flushStalePending(entry);
      return;
    }
    const chunk = (await this.host.readFrom(path, entry.transcriptOffset)).toString('utf8');

    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline === -1) {
      await this.flushStalePending(entry);
      return;
    }
    const complete = chunk.slice(0, lastNewline);
    const patch: Partial<BotEntry> = {
      transcriptOffset: entry.transcriptOffset + Buffer.byteLength(complete, 'utf8') + 1,
    };

    let lastModel = entry.lastModel;
    for (const line of complete.split('\n')) {
      if (!line) continue;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (e.type === 'system' && e.subtype === 'model_refusal_fallback') {
        this.pending.set(entry.suffix, { kind: 'refusal', seenAt: Date.now() });
        continue;
      }
      if (e.type === 'system' && e.subtype === 'model_consent_fallback') {
        this.pending.set(entry.suffix, { kind: 'consent', seenAt: Date.now() });
        continue;
      }
      if (e.type === 'system' && e.subtype === 'compact_boundary') {
        const meta = (e.compactMetadata ?? {}) as Record<string, unknown>;
        const sizes =
          typeof meta.postTokens === 'number'
            ? `${fmtTokens(meta.preTokens)} → ${fmtTokens(meta.postTokens)} tokens`
            : `${fmtTokens(meta.preTokens)} tokens compacted`;
        await this.post(
          entry,
          `🗜️ **${entry.personaName}**: context filled up and was compacted (${meta.trigger ?? '?'}) — ${sizes}. ` +
            `It keeps a summary of the conversation so far, but fine details may be lost.`,
        );
        continue;
      }

      const content = (e.message as Record<string, unknown> | undefined)?.content;
      if (Array.isArray(content)) {
        for (const block of content as Record<string, unknown>[]) {
          if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
            let uses = this.questionUses.get(entry.suffix);
            if (!uses) this.questionUses.set(entry.suffix, (uses = new Set()));
            uses.add(String(block.id));
          } else if (
            block.type === 'tool_result' &&
            entry.pendingQuestion &&
            this.questionUses.get(entry.suffix)?.has(String(block.tool_use_id))
          ) {
            await this.resolveQuestion(entry, block);
          }
        }
      }

      const model = (e.message as Record<string, unknown> | undefined)?.model as string | undefined;
      if (!model || model === '<synthetic>') continue;
      const fallback = this.pending.get(entry.suffix);
      if (fallback) {
        this.pending.delete(entry.suffix);
        await this.post(entry, this.fallbackNotice(entry, fallback.kind, model, lastModel));
      } else if (lastModel && model !== lastModel) {
        await this.post(entry, `🔀 **${entry.personaName}**: now answering as \`${model}\` (was \`${lastModel}\`).`);
      }
      lastModel = model;
    }

    if (lastModel !== entry.lastModel) patch.lastModel = lastModel;
    this.registry.update(entry, patch);
  }

  async announceQuestion(entry: BotEntry, dialog: PaneDialog & { kind: 'question' }): Promise<void> {
    const pending: PendingQuestion = {
      sig: dialogSig(dialog.q),
      postedAt: new Date().toISOString(),
      questions: [dialog.q],
      parts: dialog.parts,
    };
    log(`${entry.personaName}: ${dialog.q.kind ?? 'question'} dialog on screen — ${JSON.stringify((dialog.q.title ?? dialog.q.question).slice(0, 80))}`);
    const id = await this.notifier.postHome(entry, formatQuestionPost(entry, pending, this.spawnerName()));
    if (id !== undefined) pending.messageId = String(id);
    this.registry.update(entry, { pendingQuestion: pending });
  }

  /** `rescan`: re-check every hand's pane, (re)post what's open, clear stale state. */
  async rescanDialogs(): Promise<string[]> {
    const lines: string[] = [];
    for (const entry of this.registry.alive()) {
      let pane: string;
      try {
        pane = await this.tmux.capturePane(entry.tmuxSession);
      } catch (err) {
        // An unreadable screen is not an empty one: don't resolve anything.
        lines.push(`**${entry.personaName}** — could not read its screen (${(err as Error).message}).`);
        continue;
      }
      const dialog = parseDialogPane(pane);
      if (dialog.kind === 'question') {
        const sig = dialogSig(dialog.q);
        const what = dialog.q.kind === 'permission' ? 'permission prompt' : 'question';
        if (entry.pendingQuestion?.sig === sig && entry.pendingQuestion.messageId) {
          lines.push(`**${entry.personaName}** — ${what} already posted, still waiting (\`answer ${entry.suffix} …\`).`);
        } else {
          if (isPermission(entry)) await this.resolvePermission(entry);
          await this.announceQuestion(entry, dialog);
          lines.push(`**${entry.personaName}** — open ${what} found, posted in its home topic.`);
        }
      } else if (dialog.kind === 'review') {
        await this.tmux.sendKeys(entry.tmuxSession, '1').catch(() => undefined);
        lines.push(`**${entry.personaName}** — dialog was on its review screen; confirmed submit.`);
      } else if (isPermission(entry)) {
        await this.resolvePermission(entry);
        lines.push(`**${entry.personaName}** — its permission prompt is gone from the screen; closed it out.`);
      } else if (entry.pendingQuestion) {
        this.registry.update(entry, { pendingQuestion: undefined });
        lines.push(`**${entry.personaName}** — no dialog on screen any more; cleared its pending question.`);
      }
    }
    return lines;
  }

  private async resolveQuestion(entry: BotEntry, block: Record<string, unknown>): Promise<void> {
    const isError = block.is_error === true;
    const content = typeof block.content === 'string' ? block.content : '';
    const prefix = 'Your questions have been answered:';
    const notice = isError
      ? `🚫 **${entry.personaName}**'s question was dismissed without an answer.`
      : `✅ **${entry.personaName}** got its answer${content.startsWith(prefix) ? ` — ${content.slice(prefix.length).trim().replace(/You can now continue.*$/s, '').trim()}` : ''}`;
    await this.post(entry, notice.slice(0, 9000));
    this.registry.update(entry, { pendingQuestion: undefined });
    this.questionUses.delete(entry.suffix);
  }

  private async flushStalePending(entry: BotEntry): Promise<void> {
    const fallback = this.pending.get(entry.suffix);
    if (!fallback || Date.now() - fallback.seenAt < FALLBACK_MODEL_WAIT_MS) return;
    this.pending.delete(entry.suffix);
    await this.post(entry, this.fallbackNotice(entry, fallback.kind, undefined, entry.lastModel));
  }

  private fallbackNotice(entry: BotEntry, kind: PendingFallback['kind'], to: string | undefined, from: string | undefined): string {
    const cause =
      kind === 'refusal'
        ? `safeguards flagged a message in **${entry.personaName}**'s session`
        : `**${entry.personaName}**'s session hit a model consent fallback`;
    const swap = to
      ? `it is now answering as \`${to}\`${from ? ` (was \`${from}\`)` : ''}`
      : `Claude Code is switching it to a fallback model`;
    return `⚠️ Classifier fallback: ${cause} — ${swap}. In our experience the original model does not come back on its own for the rest of the session.`;
  }

  private async post(entry: BotEntry, content: string): Promise<void> {
    log(`${entry.personaName}: ${content.replace(/\n/g, ' ')}`);
    await this.notifier.postHome(entry, content);
  }
}
