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
 *    A prompt the pane does not show from its title down takes no answer — so
 *    the hand's terminal is made taller until it does (fit): the TUI redraws
 *    the whole prompt and it is read, posted and answered like any other. The
 *    terminal goes back to its configured height once no dialog is open.
 *    All of that is done on the hand's OWN pane — the one tmux started with
 *    the hand's conversation id — read and written by its pane id, never on
 *    "whichever pane of the session is selected" (ownPane).
 *
 * Transcripts are append-only JSONL, read from a persisted BYTE OFFSET through
 * the AgentHost (they belong to the agents user). Only complete lines advance
 * the offset.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { inferEngine } from './codex.js';
import type { AgentHost } from './host.js';
import type { Notifier } from './notifier.js';
import {
  captureText, DialogChangedError, dialogSig, formatQuestionPosts, openToolUses, parseDialogPane, sameDialog, stampExpiry,
  type DialogTerminal, type OpenToolUse, type PaneDialog, type PendingQuestion,
} from './question.js';
import type { BotEntry, Registry } from './registry.js';
import type { SessionPane, Tmux } from './tmux.js';

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

/** How tall a hand's terminal is made for a prompt, and what it goes back to. */
export interface PaneFit {
  /** The configured height of a hand's terminal (config.paneRows). */
  rows: number;
  /** The tallest it is ever made (config.paneMaxRows). */
  maxRows: number;
}
const DEFAULT_FIT: PaneFit = { rows: 50, maxRows: 1000 };
/** After a resize the TUI redraws (measured on 2.1.306 / 2.1.323: done within
 *  300 ms, at 1000 rows too). Polled until the screen has changed and holds. */
const REDRAW_POLL_MS = 150;
const REDRAW_WAIT_MS = 2500;
/** A frame that fits its pane is drawn from the top and leaves rows free under
 *  it; one that does not, fills the pane to its last row. */
const FREE_ROWS = 2;
/** Resizes for one look at a prompt: 24 rows doubled this often is past any limit. */
const MAX_GROW_STEPS = 8;

/** An answer from Zulip (not raw `press` keys) went to this permission prompt's
 *  post. One post takes one answer: whatever is on screen after it — the same
 *  prompt because the key did not take, or a request that reads the same — is
 *  not answered on the strength of that post again. This is `answered`, set
 *  when the answer's first key went out and by nothing else; what was sent
 *  last (`answeredWith`, which raw keys overwrite) says nothing about it. (A
 *  record saved before `answered` existed counts by that label: it can only
 *  make a post take no further answer.) */
export const answeredFromZulip = (pending: PendingQuestion): boolean =>
  pending.questions[0]?.kind === 'permission' &&
  (pending.answered === true || (pending.answered === undefined && pending.answeredWith !== undefined && !pending.answeredWith.startsWith('keys ')));

/**
 * Which pane of the hand's tmux session is the hand's own cannot be told, so
 * nothing is read from that session and nothing is sent to it: a prompt on
 * "the pane that is selected" may be another program's — another Claude Code
 * session's, with a request that reads like the hand's — and the transcript
 * consulted about it would still be the hand's.
 */
export class HandPaneError extends Error {}

/**
 * The hand's own pane among those of its tmux session: the one tmux started
 * with the hand's conversation id as its conversation (`--session-id <id>` at
 * launch, `--resume <id>` on revival — launcher.buildCommand; the command
 * execs into Claude Code, so that pane's program is the one writing the
 * transcript of that id). It is told by tmux's own record of each pane, every
 * time: not by which pane is selected, and not by a note of ours that could
 * outlive the pane. No such pane (it is gone, or its program has exited), or
 * several — whose it is cannot be told then, and that is an error, not a guess.
 * A pane that merely mentions the id (someone tailing the transcript) is not one.
 *
 * And a pane whose window has `synchronize-panes` on is not one to send keys
 * to: tmux would hand each key to every pane of that window.
 */
export function ownPane(panes: SessionPane[], entry: Pick<BotEntry, 'sessionId' | 'tmuxSession'>): string {
  // The flag, then the id whole (a UUID), in whatever quotes: the launcher's
  // single ones, or double ones as tmux prints them inside its own (\").
  const id = entry.sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(`--(?:session-id|resume)(?:=|\\s+)(?:\\\\?["'])?${id}(?![\\w-])`);
  const own = panes.filter((pane) => !pane.dead && named.test(pane.command));
  if (own.length === 1) {
    if (own[0].synchronized) {
      throw new HandPaneError(`the window of its pane in tmux session \`${entry.tmuxSession}\` has synchronize-panes switched on — a key for the hand would go to every pane of that window`);
    }
    return own[0].id;
  }
  const n = panes.length;
  throw new HandPaneError(own.length === 0
    ? `${n === 1 ? 'the one pane' : `none of the ${n} panes`} of its tmux session \`${entry.tmuxSession}\` is running the command this hand was started with — its own pane is gone, or was started by hand`
    : `${own.length} panes of its tmux session \`${entry.tmuxSession}\` were started with this hand's conversation id, and I cannot tell which of them is the hand`);
}

/** The dialog is a permission prompt the pane does not show from its title. */
const isCut = (dialog: PaneDialog): boolean => dialog.kind === 'question' && dialog.q.kind === 'permission' && dialog.q.terminalWhy === 'cut';

interface PendingFallback {
  kind: 'refusal' | 'consent';
  seenAt: number;
}

export class TranscriptWatcher {
  private readonly pending = new Map<string, PendingFallback>();
  /** AskUserQuestion tool_use ids seen per hand — the matching tool_result is the resolution. */
  private readonly questionUses = new Map<string, Set<string>>();
  /** Per hand (tmux session): the pane its screen was last read from, proven
   *  its own in the tmux command that read it (look). Keys go to that pane. */
  private readonly panes = new Map<string, string>();
  /** Hands whose home topic was told that their pane cannot be told. */
  private readonly paneless = new Set<string>();
  /**
   * This run of the spawner. A post of a permission prompt takes an answer
   * only in the run that made it (PendingQuestion.run, `standing`): one loaded
   * from the registry was posted by a process that is gone — under whatever
   * rules that build had for what a post must show, and with whatever it knew
   * of keys already sent on it and never got to save.
   */
  readonly run = randomBytes(8).toString('hex');

  constructor(
    private readonly registry: Registry,
    private readonly host: AgentHost,
    private readonly tmux: Tmux,
    private readonly notifier: Notifier,
    private readonly paths: { agentsHome: string; projectDir: string },
    private readonly spawnerName: () => string,
    private readonly fit: PaneFit = DEFAULT_FIT,
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
   *  transcript tool_use it asks about. Sweep, rescan, show and the answer path
   *  all read through here, so they agree on what "the same request" is — and
   *  all of them get the prompt on a pane made tall enough for it, where that
   *  can be done. Rejects when the screen cannot be read. */
  async readDialog(entry: BotEntry): Promise<PaneDialog> {
    return this.identify(entry, await this.screen(entry));
  }

  /**
   * The hand's terminal, for giving it an answer: `read` is readDialog, and
   * keys go to the pane that read looked at last — by its id, so to the pane
   * whose screen was checked and to no other, whichever pane of the session
   * is selected by the time they are sent. With no successful look there is
   * nowhere to send them.
   */
  terminal(entry: BotEntry): DialogTerminal {
    const own = (): string => {
      const pane = this.panes.get(entry.tmuxSession);
      if (!pane) throw new HandPaneError('its screen has not been read, so there is no pane to send keys to');
      return pane;
    };
    return {
      read: async () => {
        const dialog = await this.readDialog(entry);
        // A card is for the pane it was read from: the hand in another pane
        // is another process, and what it asks is another asking of it.
        const posted = entry.pendingQuestion;
        if (dialog.kind === 'question' && posted && this.fromThisRun(posted) && !this.standing(entry, posted)) {
          throw new DialogChangedError('the hand is in another terminal pane than the one this request was posted from', dialog);
        }
        return dialog;
      },
      sendKeys: (...keys) => this.tmux.sendKeys(own(), ...keys),
      sendText: (text) => this.tmux.sendText(own(), text),
    };
  }

  /** Where this hand's terminal is, for raw keys, `peek` and the live model
   *  switch: its own pane (by id). Rejects (HandPaneError) when that cannot be
   *  told. Only Claude Code hands are started in a way that tells it; a Codex
   *  hand is its session's active pane, as before. */
  async handPane(entry: BotEntry): Promise<string> {
    if ((entry.engine ?? inferEngine(entry.model)) === 'codex') return entry.tmuxSession;
    return ownPane((await this.tmux.sessionPanes(entry.tmuxSession)).panes, entry);
  }

  /** Was this post made by this run of the spawner? A permission prompt's
   *  post takes an answer only then (see `run`). Needs no look at anything. */
  fromThisRun(pending: PendingQuestion): boolean {
    return pending.questions[0]?.kind !== 'permission' || pending.run === this.run;
  }

  /** Does this post still take an answer? A permission prompt's does only in
   *  the run that made it, and only for the pane it was read from — which is
   *  compared with the pane of the last look, so this is asked after one. */
  standing(entry: BotEntry, pending: PendingQuestion): boolean {
    if (pending.questions[0]?.kind !== 'permission') return true;
    return pending.run === this.run && pending.pane !== undefined && pending.pane === this.panes.get(entry.tmuxSession);
  }

  /**
   * The hand's own pane and what it shows, with its text attributes (in one
   * capture, the rows and which of them is set as a dialog's title —
   * question.ts, dialogTitleRow). One tmux command lists the session's panes
   * and captures the one that was the hand's at the last look, so "this is the
   * hand's pane" and "this is its screen" are of the same moment; only when
   * that pane is not the hand's any more (or at the first look) is it found
   * first. Rejects with HandPaneError when the hand's pane cannot be told.
   */
  private async look(entry: BotEntry): Promise<{ pane: string; screen: string }> {
    let guess = this.panes.get(entry.tmuxSession);
    try {
      for (let tries = 0; tries < 2; tries++) {
        const { panes, screen } = await this.tmux.sessionPanes(entry.tmuxSession, guess, true);
        const own = ownPane(panes, entry);
        if (own === guess && screen !== undefined) {
          this.panes.set(entry.tmuxSession, own);
          return { pane: own, screen };
        }
        guess = own;
      }
      throw new HandPaneError(`the panes of its tmux session \`${entry.tmuxSession}\` changed while I looked`);
    } catch (err) {
      // No proven pane, no place for keys (a tmux failure of another kind
      // says nothing about whose pane it is: that note stays).
      if (err instanceof HandPaneError) this.panes.delete(entry.tmuxSession);
      throw err;
    }
  }

  private async screen(entry: BotEntry): Promise<string> {
    return (await this.look(entry)).screen;
  }

  /** A permission prompt whose top is off screen is not left at that: the pane
   *  is made taller, the TUI redraws, and the prompt is read again — until it
   *  is on screen from its title, or the pane cannot grow further. */
  private async identify(entry: BotEntry, pane: string): Promise<PaneDialog> {
    let dialog = await this.identifyOnce(entry, pane);
    // Each step at least doubles the height, so a handful reaches any limit.
    for (let steps = 0; steps < MAX_GROW_STEPS && isCut(dialog) && (await this.grow(entry)); steps++) {
      dialog = await this.identifyOnce(entry, await this.screen(entry));
    }
    return stampExpiry(dialog);
  }

  /** `pane` only decides whether the transcript is needed at all. Reading it
   *  takes time — two subprocesses on a split-user host — in which the prompt
   *  can be answered at the terminal, expire, or give way to the next request.
   *  So a permission prompt is always identified from a capture taken AFTER
   *  that read, and NOTHING is read after that capture: what is returned is
   *  the last thing looked at, parsed with what was known when it was taken.
   *  (Which calls were pending then is only as good as the read before it —
   *  and where that leaves open which request is on screen, the prompt takes
   *  no answer: question.ts, parsePermissionPane.) */
  private async identifyOnce(entry: BotEntry, pane: string): Promise<PaneDialog> {
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
        // read by its rows, like one with no transcript.
        const posted = entry.pendingQuestion?.questions[0];
        if (posted?.toolUseId || posted?.lookalikes) throw new Error(`could not read its transcript (${(err as Error).message})`);
      }
      dialog = parseDialogPane(await this.screen(entry), open ?? []);
      // The tool_use line can trail its dialog: look once more — transcript,
      // then screen — before settling for the rows. Only the hand's own Bash
      // prompt can be waiting for one.
      if (dialog.kind !== 'question' || !open || settled || !dialog.awaitsToolUse) return dialog;
      await sleep(TOOL_USE_SETTLE_MS);
    }
  }

  /**
   * Make the hand's pane taller for a prompt that does not fit it: twice the
   * height (at least the configured one), up to the limit. False when there is
   * nothing to gain — the pane is at the limit, the frame on it leaves rows
   * free (then a taller pane shows nothing more), or tmux would not resize it.
   * Only the height changes: the width decides how the request wraps, and a
   * prompt that was whole before reads the same after. It is the window that
   * is resized, by as many rows as the pane is to gain and with its width
   * untouched: in a window someone has split, the panes beside this one grow
   * with it and none gets narrower (stacked panes share the rows; the next
   * step adds more). The pane sized, and the window, are the hand's own —
   * by pane id — not whichever is selected.
   *
   * This is the screen doing the proving, as everywhere else: nothing is
   * assumed about the rows that were off screen, they are put on screen.
   */
  private async grow(entry: BotEntry): Promise<boolean> {
    let before: string;
    let pane: string;
    let size: Awaited<ReturnType<Tmux['paneSize']>>;
    try {
      const seen = await this.look(entry);
      pane = seen.pane;
      before = captureText(seen.screen);
      size = await this.tmux.paneSize(pane);
    } catch {
      return false; // no size, no resize: the prompt stays as it reads
    }
    const rows = Math.min(this.fit.maxRows, Math.max(this.fit.rows, size.rows * 2));
    if (rows <= size.rows) return false;
    if (before.split('\n').slice(0, size.rows).slice(-FREE_ROWS).every((row) => !row.trim())) return false;
    // What is drawn, whatever the pane's height: tmux pads a taller pane with
    // blank rows at once, the TUI's redraw comes after.
    const drawn = (text: string) => text.replace(/\s+$/, '');
    let now: typeof size;
    try {
      await this.tmux.resizeWindowRows(pane, size.windowRows + rows - size.rows);
      // tmux may accept the command and keep the size (a window it will not
      // size by hand): then there is nothing to wait for, now or next time.
      now = await this.tmux.paneSize(pane);
      if (now.rows <= size.rows) throw new Error('its size did not change');
    } catch (err) {
      log(`${entry.personaName}: could not make its pane ${rows} rows tall (${(err as Error).message})`);
      return false;
    }
    log(`${entry.personaName}: pane ${size.cols}x${size.rows} → ${now.cols}x${now.rows} for a prompt that did not fit`);
    // A window with several panes goes back to the height it had: what each
    // pane gets of it is tmux's layout, not ours to work out.
    if (!entry.paneGrown) this.registry.update(entry, { paneGrown: true, ...(size.panes > 1 ? { paneWindowRows: size.windowRows } : {}) });
    // Read on only once the redraw is in: what is drawn differs from before
    // the resize, and two looks in a row agree. A screen that stays as it was
    // is read as it is — and not grown further on the strength of it.
    let last: string | undefined;
    for (let waited = 0; waited < REDRAW_WAIT_MS; waited += REDRAW_POLL_MS) {
      await sleep(REDRAW_POLL_MS);
      const seen = await this.screen(entry).then((pane) => drawn(captureText(pane)), () => undefined);
      if (seen !== undefined && seen !== drawn(before) && seen === last) return true;
      last = seen;
    }
    log(`${entry.personaName}: no redraw seen within ${REDRAW_WAIT_MS} ms of the resize`);
    return false;
  }

  /** No dialog is open: a pane grown for one goes back to its configured
   *  height — the window loses the rows the pane has too many, its width
   *  stays. A window that had several panes when it was grown goes back to
   *  the height it had then. Best effort — it is tried again at the next
   *  sweep. */
  private async restore(entry: BotEntry): Promise<void> {
    const pane = this.panes.get(entry.tmuxSession);
    if (!entry.paneGrown || !pane) return;
    try {
      const size = await this.tmux.paneSize(pane);
      const rows = size.panes > 1 && entry.paneWindowRows !== undefined
        ? entry.paneWindowRows
        : size.windowRows - Math.max(0, size.rows - this.fit.rows);
      if (rows < size.windowRows) {
        await this.tmux.resizeWindowRows(pane, rows);
        log(`${entry.personaName}: window back to ${rows} rows (its pane was ${size.cols}x${size.rows})`);
      }
      this.registry.update(entry, { paneGrown: undefined, paneWindowRows: undefined });
    } catch (err) {
      log(`${entry.personaName}: could not restore its pane height (${(err as Error).message})`);
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
    let pane: string;
    try {
      pane = await this.screen(entry);
    } catch (err) {
      if (err instanceof HandPaneError) await this.paneLost(entry, err);
      return;
    }
    this.paneless.delete(entry.tmuxSession);
    if (!pane) return;
    const dialog = await this.identify(entry, pane);
    if (dialog.kind === 'review') {
      // Only auto-confirm reviews of dialogs we drove from Zulip.
      if (entry.pendingQuestion) {
        log(`${entry.personaName}: dialog on review screen — confirming submit`);
        await this.confirmReview(entry);
      }
      return;
    }
    if (dialog.kind === 'question') {
      if (entry.pendingQuestion && sameDialog(entry.pendingQuestion, dialog.q)) {
        // Posted already — unless the post failed: retry it every sweep. And
        // unless that post takes no answer any more while the prompt is still
        // there, which then gets a new one: an answer from Zulip went to it
        // (actions.answer), or it was made by an earlier run of the spawner,
        // or for another pane.
        if (entry.pendingQuestion.messageId === undefined || answeredFromZulip(entry.pendingQuestion) || this.lapsed(entry, entry.pendingQuestion, dialog.q)) {
          await this.announceQuestion(entry, dialog);
        }
        return;
      }
      // A different signature could be a refreshed snapshot (e.g. after an
      // upgrade), not a terminal answer. Replace the post without resolving it.
      await this.announceQuestion(entry, dialog);
      return;
    }
    // Permission prompts leave no marker we can key on: the dialog vanishing IS the resolution.
    if (isPermission(entry)) await this.resolvePermission(entry);
    await this.restore(entry);
  }

  /** The post of a prompt that could be answered from here was made by an
   *  earlier run of the spawner, or for another pane than the hand is in: it
   *  authorizes nothing now (`standing`). (A prompt that takes no answer
   *  anyway keeps its one notification.) */
  private lapsed(entry: BotEntry, pending: PendingQuestion, now: PendingQuestion['questions'][number]): boolean {
    return !this.standing(entry, pending) && !now.requiresTerminal;
  }

  /** `1` on the final review screen of a dialog — to the pane it was just read from. */
  private async confirmReview(entry: BotEntry): Promise<void> {
    const pane = this.panes.get(entry.tmuxSession);
    if (pane) await this.tmux.sendKeys(pane, '1').catch(() => undefined);
  }

  /** The hand's pane cannot be told (or keyed alone): its prompts are not
   *  read and take no answer until it can. Its home topic is told once per
   *  such spell — once the telling got through. */
  private async paneLost(entry: BotEntry, err: HandPaneError): Promise<void> {
    if (this.paneless.has(entry.tmuxSession)) return;
    const content = `⚠️ **${entry.personaName}**: ${err.message}. I read a hand's prompts from its own pane and send keys only there, ` +
      'so until this is put right I relay none of its permission prompts or questions, and pass on no answer to them.';
    log(`${entry.personaName}: ${content}`);
    if ((await this.notifier.postHome(entry, content)) !== undefined) this.paneless.add(entry.tmuxSession);
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

  /** Post the dialog and make it the hand's pending one. A long permission
   *  request goes out whole over a few posts; a very long one as its two ends
   *  (not approved from Zulip on that) unless `full` — then all of it. It
   *  counts as posted only when every post went out: until then it takes no
   *  answer and is posted again at the next sweep. */
  async announceQuestion(entry: BotEntry, dialog: PaneDialog & { kind: 'question' }, full = false): Promise<boolean> {
    const before = entry.pendingQuestion;
    const pending: PendingQuestion = {
      sig: dialogSig(dialog.q),
      postedAt: new Date().toISOString(),
      questions: [dialog.q],
      parts: dialog.parts,
      run: this.run,
      // Every post follows a look at the hand's pane: this is that pane.
      pane: this.panes.get(entry.tmuxSession),
      // The same prompt, posted again because its earlier post authorizes
      // nothing any more (another run's, or for another pane): the new post
      // says so — and still does when it takes a second try to get it out.
      ...(before && sameDialog(before, dialog.q) && (before.messageId !== undefined ? this.lapsed(entry, before, dialog.q) : before.renewed === true) ? { renewed: true } : {}),
    };
    log(`${entry.personaName}: ${dialog.q.kind ?? 'question'} dialog on screen — ${JSON.stringify((dialog.q.title ?? dialog.q.question).slice(0, 80))}`);
    const { posts, abridged } = formatQuestionPosts(entry, pending, this.spawnerName(), this.registry.commandTarget(entry), full);
    if (abridged) pending.abridged = true;
    let first: number | undefined;
    let last: number | undefined;
    let posted = true;
    for (const post of posts) {
      last = await this.notifier.postHome(entry, post);
      if (last === undefined) {
        posted = false;
        break;
      }
      first ??= last;
    }
    if (posted && first !== undefined) {
      pending.messageId = String(first);
      if (last !== first) pending.lastMessageId = String(last);
    }
    this.registry.update(entry, { pendingQuestion: pending });
    return posted;
  }

  /** `show`: read this hand's screen now and post what is open on it — a
   *  permission request in full, however long. The post it makes is the one
   *  an answer is then checked against. */
  async showDialog(entry: BotEntry): Promise<string> {
    let dialog: PaneDialog;
    try {
      dialog = await this.readDialog(entry);
    } catch (err) {
      return `could not read its screen (${(err as Error).message}); nothing was changed.`;
    }
    if (dialog.kind === 'question') {
      const what = dialog.q.kind === 'permission' ? 'permission prompt' : 'question';
      const posted = await this.announceQuestion(entry, dialog, true);
      return posted
        ? `its ${what}, as its screen shows it now, is posted in its home topic${dialog.q.requiresTerminal ? ' (it takes no answer from here yet — the post says why)' : ' — answer that post'}.`
        : `its ${what} is open, but I could not post it in its home topic; I will retry.`;
    }
    if (dialog.kind === 'review') return 'its dialog is on the final review screen; `rescan` confirms it.';
    if (isPermission(entry)) {
      await this.resolvePermission(entry);
      return 'no prompt is on its screen any more — it was answered at the terminal or it expired; closed it out.';
    }
    if (entry.pendingQuestion) {
      this.registry.update(entry, { pendingQuestion: undefined });
      return 'no dialog is on its screen any more; cleared its pending question.';
    }
    return 'no dialog is open on its screen.';
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
        const what = dialog.q.kind === 'permission' ? 'permission prompt' : 'question';
        if (entry.pendingQuestion?.messageId && sameDialog(entry.pendingQuestion, dialog.q) && !this.lapsed(entry, entry.pendingQuestion, dialog.q)) {
          const hint = dialog.q.requiresTerminal ? 'respond in the terminal' : `\`answer ${this.registry.commandTarget(entry)} …\``;
          lines.push(`**${entry.personaName}** — ${what} already posted, still waiting (${hint}).`);
        } else {
          const posted = await this.announceQuestion(entry, dialog);
          const status = posted ? 'posted in its home topic' : 'could not post in its home topic; will retry';
          lines.push(`**${entry.personaName}** — open ${what} found, ${status}.`);
        }
      } else if (dialog.kind === 'review') {
        await this.confirmReview(entry);
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
