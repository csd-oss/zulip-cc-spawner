/**
 * TranscriptWatcher (ported from cc-spawner) — surfaces a hand's invisible
 * session events in its home topic:
 *
 *  - `model_refusal_fallback` / `model_consent_fallback`: Claude Code silently
 *    switched the session to a fallback model (observed sticky).
 *  - `compact_boundary`: the context was compacted.
 *  - any change of the answering model.
 *  - open AskUserQuestion dialogs / permission prompts, detected from the tmux
 *    pane, posted and resolved here. A Bash permission prompt is identified by
 *    the one pending tool_use in the transcript that fits what it displays,
 *    plus its rows from title to command box (see question.ts): the rest of
 *    the pane redraws every second while its countdown runs, those do not.
 *    A prompt the pane does not show from its title down is posted once, for
 *    the terminal, and takes no answer from here.
 *
 * Transcripts are append-only JSONL, read from a persisted BYTE OFFSET through
 * the AgentHost (they belong to the agents user). Only complete lines advance
 * the offset.
 */
import { join } from 'node:path';
import type { AgentHost } from './host.js';
import type { Notifier } from './notifier.js';
import { dialogSig, formatQuestionPost, openToolUses, parseDialogPane, type OpenToolUse, type PaneDialog, type PendingQuestion } from './question.js';
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

/** How much of the transcript's end is searched for pending tool_uses. One
 *  turn's bookkeeping lines run to ~100 KB and the tool_use line follows them. */
const TOOL_USE_TAIL_BYTES = 4 * 1024 * 1024;
/** The tool_use line lands within ~50 ms of its dialog (measured on 2.1.306 /
 *  2.1.323): look once more before settling for a pane-derived identity. */
const TOOL_USE_SETTLE_MS = 500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  transcriptPath(sessionId: string, workDir?: string): string {
    return transcriptPath(this.paths.agentsHome, workDir ?? this.paths.projectDir, sessionId);
  }

  async sweep(): Promise<void> {
    for (const entry of this.registry.alive()) {
      if (entry.engine === 'codex') continue;
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

  /** The dialog on the hand's screen now, a Bash permission prompt tied to the
   *  transcript tool_use it asks about. Sweep, rescan and the answer path all
   *  read through here, so they agree on what "the same request" is. Rejects
   *  when the screen cannot be read. */
  async readDialog(entry: BotEntry): Promise<PaneDialog> {
    return this.identify(entry, await this.screen(entry));
  }

  /** The hand's screen with its text attributes: in one capture, the rows and
   *  which of them is set as a dialog's title (question.ts, dialogTitleRow). */
  private screen(entry: BotEntry): Promise<string> {
    return this.tmux.capturePane(entry.tmuxSession, 0, true);
  }

  /** `pane` only decides whether the transcript is needed at all. Reading it
   *  takes time — two subprocesses on a split-user host — in which the prompt
   *  can be answered at the terminal, expire, or give way to the next request.
   *  So a permission prompt is always identified from a capture taken AFTER
   *  that read: the caller gets the screen as it is once all our I/O is done,
   *  never the one from before it. */
  private async identify(entry: BotEntry, pane: string): Promise<PaneDialog> {
    let dialog = parseDialogPane(pane);
    for (let settled = false; ; settled = true) {
      if (dialog.kind !== 'question' || dialog.q.kind !== 'permission') return dialog;
      let open: OpenToolUse[] | undefined;
      try {
        open = await this.pendingToolUses(entry);
      } catch (err) {
        // A read that fails while a prompt identified with the transcript is
        // posted says nothing about that prompt: leave it alone (no repost,
        // no keys) until we can read. With nothing such posted the prompt is
        // bridged by its rows, like one with no transcript.
        const posted = entry.pendingQuestion?.questions[0];
        if (posted?.toolUseId || posted?.lookalikes) throw new Error(`could not read its transcript (${(err as Error).message})`);
      }
      dialog = parseDialogPane(await this.screen(entry), open ?? []);
      // The tool_use line can trail its dialog: look once more, then settle
      // for the rows. Only the hand's own Bash prompt can be waiting for one.
      if (dialog.kind !== 'question' || !dialog.awaitsToolUse || !open || settled) return dialog;
      await sleep(TOOL_USE_SETTLE_MS);
    }
  }

  /** Unresolved tool_uses from the transcript's tail; undefined without a transcript. */
  private async pendingToolUses(entry: BotEntry): Promise<OpenToolUse[] | undefined> {
    const path = this.transcriptPath(entry.sessionId, entry.workDir);
    const size = await this.host.size(path);
    if (size === undefined) return undefined;
    const from = Math.max(0, size - TOOL_USE_TAIL_BYTES);
    const tail = (await this.host.readFrom(path, from)).toString('utf8');
    // Read from mid-file, the first line is cut short: drop it.
    return openToolUses(from > 0 ? tail.slice(tail.indexOf('\n') + 1) : tail);
  }

  private async checkDialog(entry: BotEntry): Promise<void> {
    const pane = await this.screen(entry).catch(() => '');
    if (!pane) return;
    const dialog = await this.identify(entry, pane);
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
      // A different signature could be a refreshed snapshot (e.g. after an
      // upgrade), not a terminal answer. Replace the post without resolving it.
      await this.announceQuestion(entry, dialog);
      return;
    }
    // Permission prompts leave no marker we can key on: the dialog vanishing IS the resolution.
    if (isPermission(entry)) await this.resolvePermission(entry);
  }

  private async resolvePermission(entry: BotEntry): Promise<void> {
    const pending = entry.pendingQuestion;
    if (!pending) return;
    if (pending.messageId) {
      const q = pending.questions[0];
      const denied = /^(no|deny|reject|esc)/i.test(pending.answeredWith ?? '');
      const icon = pending.answeredWith ? (denied ? '🚫' : '✅') : 'ℹ️';
      const status = pending.answeredWith
        ? `is resolved — **${pending.answeredWith}** sent from Zulip`
        : 'is no longer on screen';
      await this.post(entry, `${icon} **${entry.personaName}**'s permission prompt (${q.title ?? 'tool use'}) ${status}.`);
    }
    this.registry.update(entry, { pendingQuestion: undefined });
  }

  private async check(entry: BotEntry): Promise<void> {
    const path = this.transcriptPath(entry.sessionId, entry.workDir);
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

  async announceQuestion(entry: BotEntry, dialog: PaneDialog & { kind: 'question' }): Promise<boolean> {
    const pending: PendingQuestion = {
      sig: dialogSig(dialog.q),
      postedAt: new Date().toISOString(),
      questions: [dialog.q],
      parts: dialog.parts,
    };
    log(`${entry.personaName}: ${dialog.q.kind ?? 'question'} dialog on screen — ${JSON.stringify((dialog.q.title ?? dialog.q.question).slice(0, 80))}`);
    const id = await this.notifier.postHome(entry, formatQuestionPost(entry, pending, this.spawnerName(), this.registry.commandTarget(entry)));
    if (id !== undefined) pending.messageId = String(id);
    this.registry.update(entry, { pendingQuestion: pending });
    return id !== undefined;
  }

  /** `rescan`: re-check every hand's pane, (re)post what's open, clear stale state. */
  async rescanDialogs(): Promise<string[]> {
    const lines: string[] = [];
    for (const entry of this.registry.alive()) {
      if (entry.engine === 'codex') continue;
      let dialog: PaneDialog;
      try {
        dialog = await this.readDialog(entry);
      } catch (err) {
        // An unreadable screen is not an empty one: don't resolve anything.
        lines.push(`**${entry.personaName}** — could not read its screen (${(err as Error).message}).`);
        continue;
      }
      if (dialog.kind === 'question') {
        const sig = dialogSig(dialog.q);
        const what = dialog.q.kind === 'permission' ? 'permission prompt' : 'question';
        if (entry.pendingQuestion?.sig === sig && entry.pendingQuestion.messageId) {
          const hint = dialog.q.requiresTerminal ? 'respond in the terminal' : `\`answer ${this.registry.commandTarget(entry)} …\``;
          lines.push(`**${entry.personaName}** — ${what} already posted, still waiting (${hint}).`);
        } else {
          const posted = await this.announceQuestion(entry, dialog);
          const status = posted ? 'posted in its home topic' : 'could not post in its home topic; will retry';
          lines.push(`**${entry.personaName}** — open ${what} found, ${status}.`);
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
