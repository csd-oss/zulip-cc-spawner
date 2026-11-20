import { canonicalHandTarget } from './names.js';
/**
 * Ported from cc-spawner (src/question.ts); posts reworded for Zulip;
 * tmux via the Tmux class.
 *
 * Multiple-choice bridge — when a spawned bot's session raises an
 * AskUserQuestion dialog, the session BLOCKS on an interactive TUI nobody is
 * watching. This module turns that dialog into a channel post and turns channel
 * answers back into keystrokes.
 *
 * DETECTION IS PANE-BASED: the tmux pane tells us a dialog is open, what its
 * options are and how it takes input. On claude 2.1.241 (verified live
 * 2026-08-24) the transcript had no trace of an open dialog — tool_use and
 * tool_result were written together on resolution, as the confirmation.
 *
 * A BASH PERMISSION PROMPT IS IDENTIFIED WITH THE TRANSCRIPT'S HELP — verified
 * live 2026-11-20 on claude 2.1.306 and 2.1.323: the assistant tool_use line
 * (id + full input) is in the transcript while the prompt is open (it lands
 * within ~50 ms of the dialog), and the tool_result when it resolves. The pane
 * is a lossy rendering of that request — wrapped to the width, its top scrolled
 * off when the command is long, with an expiry countdown that ticks every
 * second. So "is this still the request I posted" is answered by a pending
 * tool_use id plus the dialog's own rows from its title to the end of its
 * command box — never by guessing which rows around them are a timer.
 *
 * The transcript is a HINT, the screen is the EVIDENCE (bindBash):
 *  - a pending tool_use is not necessarily the one being asked about (of two
 *    calls in a turn the first may be running while the second asks; a
 *    subagent's request is not in this file at all), so a dialog is tied only
 *    to the single pending call that fits everything it displays — command,
 *    description, title — and to none when several fit or the title names
 *    another requester;
 *  - the transcript belongs to the hand, so nothing from it is ever posted as
 *    the request: the post is what the terminal shows.
 *
 * ONE RULE FOR ANSWERS: a prompt takes an answer from Zulip only when the pane
 * positively shows what is being approved — the dialog from its title down
 * (dialogTitleRow). Whatever the pane does not prove is not assumed: a prompt
 * whose start is not on screen is posted for the terminal, as far as it shows,
 * and no key goes to it from here, whether a pending call fits it or not. Such
 * a post is a notification; its identity — a fitting call's id, else its rows
 * with the expiry notice's clock set aside (dialogSig) — only keeps it from
 * being repeated, and is never what a key is sent on.
 *
 * TUI mechanics (verified live against claude 2.1.241):
 *  - single-select: pressing the option digit selects AND submits immediately
 *  - multiSelect: digits toggle [✔]; Tab advances
 *  - multi-question: one question on screen at a time (tab bar
 *    `←  ☐ A  ☐ B  ✔ Submit  →`); after the last, a "Review your answers …
 *    1. Submit answers" screen appears — we bridge these dialogs one screen at
 *    a time and auto-confirm the review
 *  - free text: a numbered "Type something." entry — digit, type, Enter
 *  - Esc cancels the whole dialog (tool_result becomes a rejection)
 * Every dialog screen carries the "Chat about this" footer entry — the marker.
 *
 * PERMISSION PROMPTS are bridged the same way (verified live 2026-09-01,
 * claude 2.1.258): even under --dangerously-skip-permissions, Claude Code still
 * stops on a few safety checks ("Dangerous rm operation on possibly-empty
 * variable path: …") with a `Do you want to proceed? ❯ 1. Yes / 2. No` dialog
 * and an "Esc to cancel · Tab to amend" footer. A "No" yields an is_error
 * tool_result "The user doesn't want to proceed with this tool use…". Digits
 * select AND submit in the cursor list (the screen-reader layout wants digit
 * then Enter and is never driven from here). Resolution is observed pane-side
 * (the dialog disappears). A subagent's prompt ("Bash command · from the …
 * agent") has its tool_use in the subagent's own transcript, not the hand's.
 */
import type { Tmux } from './tmux.js';
import type { BotEntry } from './registry.js';

/** The currently displayed question of a dialog, parsed from the pane. */
export interface PendingQ {
  /** AskUserQuestion (default) or a tool permission prompt. */
  kind?: 'question' | 'permission';
  /** Permission prompts: the dialog title ("Bash command", "Edit file", …). */
  title?: string;
  /** Permission prompts: the rows above the question, as displayed. */
  detail?: string;
  /** Bash prompts: the one pending tool_use that fits what the dialog displays.
   *  With `shown`, the identity of the request. */
  toolUseId?: string;
  /** Several pending tool_uses fit what the dialog displays — which of them is
   *  asking cannot be told from here. Never answered from Zulip. */
  lookalikes?: string[];
  /** The dialog's rows from its title (or the top of the pane) to the end of
   *  its command box, as displayed: queue position, description, command. */
  shown?: string;
  /** No verified way to answer this from Zulip; use the terminal. */
  requiresTerminal?: boolean;
  /** Why: `input` — not the cursor list, where a digit selects and submits;
   *  `cut` — the pane does not show the dialog from its title down, so the
   *  request, or whose it is, cannot be shown; `lookalike` — see `lookalikes`. */
  terminalWhy?: 'input' | 'cut' | 'lookalike';
  question: string;
  multiSelect: boolean;
  options: { label: string }[];
  /** The dialog number of the "Type something." entry (free-text answers). */
  textOptionIndex?: number;
}

export interface PendingQuestion {
  /** Identity of the displayed question (dialogSig) — a changed sig means a
   *  different request, or the dialog's next part (repost). */
  sig: string;
  /** Relay id of the channel post presenting the dialog — the reply target. */
  messageId?: string;
  postedAt: string;
  /** The question currently on screen (dialogs are bridged screen by screen). */
  questions: PendingQ[];
  /** Tab-bar headers when the dialog has several parts (e.g. Scope, Size). */
  parts?: string[];
  /** What was sent from the channel (`answer`/`press`) — used to word the
   *  resolution notice for permission prompts, which resolve pane-side. */
  answeredWith?: string;
}

/** An assistant tool_use in the hand's transcript with no tool_result yet. */
export interface OpenToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type PaneDialog =
  | { kind: 'none' }
  | { kind: 'review' }
  /** `awaitsToolUse`: looks like the hand's own Bash prompt, but no pending
   *  tool_use shows it — its transcript line may not have been written yet. */
  | { kind: 'question'; q: PendingQ; parts?: string[]; awaitsToolUse?: boolean };

const FOOTER_RE = /^\s*\d+\.\s+Chat about this/;
const OPTION_RE = /^\s*(?:❯\s*)?(\d+)\.\s+(.*\S)\s*$/;
const CHECKBOX_RE = /^\[[ ✔x]\]\s*/i;
const TYPE_SOMETHING_RE = /^type something\.?$/i;
const REVIEW_RE = /Ready to submit your answers\?/;
const TAB_BAR_RE = /[☐☒]/;
const PERM_QUESTION_RE = /^\s*Do you want to [^?]*\?\s*$/;
/** Everything under the options, rows joined: optional input instructions,
 *  then the footer, which starts "Esc to cancel" and may go on with hints. */
const PERM_TAIL_RE = /^(.*?)\s*\b(Esc to cancel\b.*)$/;
/** The cursor list — where a digit selects and submits — says so in its
 *  footer: Tab switches it to amending the answer with typed text. In that
 *  mode (footer "Esc to cancel" alone) a digit is text, not a choice. */
const DIGIT_LIST_FOOTER_RE = /\bTab to amend\b/;
/** The title row of the hand's own Bash prompt, with its place in the queue
 *  when several requests wait. A subagent's reads "Bash command · from the
 *  general-purpose agent" (in two columns on a narrow pane), and its tool_use
 *  lives in the subagent's transcript. */
const OWN_BASH_TITLE_RE = /^ Bash command(?: {2,}\d+ of \d+)?$/;
/** Either requester's title row, as it reads when it is the pane's first row. */
const BASH_TITLE_ROW_RE = /^ Bash command(?: · from the \S.* agent)?(?: {2,}\d+ of \d+)?$/;
/** …and its attributes there (see readCapture): the words "Bash command" bold,
 *  the margin before them and everything after them not. */
const BASH_TITLE_BOLD_RE = /^01{12}0*$/;
/** Shown under the title for a call without a description (2.1.306, 2.1.323). */
const DEFAULT_BASH_DESCRIPTION = 'Run shell command';
const SEPARATOR_RE = /^─{6,}\s*$/;
const BOX_BORDER_RE = /^╌{6,}\s*$/;
const BOX_GUTTER_RE = /^ │(?: |$)/;
const AX_PERMISSION_TITLE_RE = /^Permission Required: (.+)$/;
const AX_PERMISSION_INPUT_RE = /^Select with numbers \[\d+-\d+\]\. Then Enter to submit or Escape to cancel:/;

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const squeeze = (s: string): string => s.replace(/\s+/g, '');

/** What `tmux capture-pane -e` adds to the text: SGR (`ESC [ … m`, the one
 *  read here), hyperlinks (OSC 8) and charset shifts. Any other sequence is
 *  dropped the same way; none is ever left in a row. */
const CAPTURE_ESCAPE_RE = /\x1b(?:\[([0-9;:]*)m|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]*[0-~]?)|[\x0e\x0f]/g;

/** Bold after one SGR sequence. Colours take parameters of their own
 *  (38;5;n, 38;2;r;g;b) that are not attribute codes. */
function boldAfter(params: string, bold: boolean): boolean {
  const p = params.split(';');
  for (let i = 0; i < p.length; i++) {
    const code = Number(p[i].split(':')[0]);
    if (code === 1) bold = true;
    else if (code === 0 || code === 22) bold = false;
    else if ((code === 38 || code === 48 || code === 58) && !p[i].includes(':')) i += p[i + 1] === '5' ? 2 : p[i + 1] === '2' ? 4 : 0;
  }
  return bold;
}

/**
 * A pane capture as rows of text plus, per row, which characters are bold
 * ('1') and which are not ('0'). A capture taken with attributes (`tmux
 * capture-pane -e`) carries them as escape sequences, the state running on
 * from row to row; a plain capture has none, and then nothing is bold. The
 * text is the same either way (checked on every live capture pair of this
 * change).
 *
 * Bold is read only by dialogTitleRow. With no opening rule, a Bash title
 * must be the first row above a whole command box, with only the words
 * "Bash command" bold. On 2.1.306 and 2.1.323 a description in that position
 * is dim, not bold: the TUI shows an ESC in it as "\uFFFD" and does not
 * render markdown there.
 */
function readCapture(capture: string): { lines: string[]; bold: string[] } {
  const lines: string[] = [];
  const bold: string[] = [];
  let on = false;
  for (const raw of capture.split('\n')) {
    let text = '';
    let mask = '';
    let last = 0;
    const add = (piece: string) => {
      text += piece;
      mask += (on ? '1' : '0').repeat(piece.length);
    };
    for (const m of raw.matchAll(CAPTURE_ESCAPE_RE)) {
      add(raw.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[1] !== undefined) on = boldAfter(m[1], on);
    }
    add(raw.slice(last));
    // A plain capture ends each row at its last non-space; with attributes,
    // spaces written in a colour stay. Read both the same.
    text = text.replace(/ +$/, '');
    lines.push(text);
    bold.push(mask.slice(0, text.length));
  }
  return { lines, bold };
}

/** The text of a pane capture, without the attributes `capture-pane -e` adds. */
export const captureText = (capture: string): string => readCapture(capture).lines.join('\n');

/** Unresolved tool_use blocks of the main conversation, in transcript order.
 *  `jsonl` is whole lines from the tail of the hand's transcript. */
export function openToolUses(jsonl: string): OpenToolUse[] {
  const open = new Map<string, OpenToolUse>();
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"tool_use') && !line.includes('"tool_result"')) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if ((e.type !== 'assistant' && e.type !== 'user') || e.isSidechain === true) continue;
    const content = (e.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Record<string, unknown>[]) {
      if (e.type === 'assistant' && block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        open.set(block.id, { id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
      } else if (e.type === 'user' && block?.type === 'tool_result') {
        open.delete(String(block.tool_use_id));
      }
    }
  }
  return [...open.values()];
}

/** Do the box rows show exactly `command` — or, when the top of the box has
 *  scrolled off (`whole` false), its tail? The renderer wraps long lines and
 *  expands tabs, so rows may differ from the command in the amount of
 *  whitespace and in where lines break, and in nothing else. */
function boxShows(command: string, rows: string[], whole: boolean): boolean {
  const cmd = collapse(command);
  let pos = cmd.length;
  let seen = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (cmd[pos - 1] === ' ') pos--; // a line break stands for at most one run of whitespace
    const row = collapse(rows[i]);
    if (!row) continue;
    if (!cmd.endsWith(row, pos)) return false;
    pos -= row.length;
    seen = true;
  }
  return seen && (!whole || pos === 0);
}

/** Wrapped and multi-line text is shown with a " │ " gutter on every row,
 *  short text bare (even where a narrow pane wraps it). A mix is not a block
 *  we know. */
function ungutter(rows: string[]): string[] | undefined {
  const guttered = rows.filter((row) => BOX_GUTTER_RE.test(row)).length;
  if (guttered === 0) return rows;
  return guttered === rows.length ? rows.map((row) => row.replace(BOX_GUTTER_RE, '')) : undefined;
}

/** The top of a boxed permission dialog, as far as it is on screen:
 *  rule · title · description · ╌╌╌ · command or file rows · ╌╌╌. */
interface BoxFrame {
  /** The rule that opens the dialog is on screen: `header[0]` is its title row. */
  ruled: boolean;
  /** Index of the first of the dialog's rows on screen below that rule. */
  start: number;
  /** Rows above the box: title and description, or what is left of them. */
  header: string[];
  /** Rows inside the box — with `whole` false, only its end: the pane starts inside it. */
  rows: string[];
  whole: boolean;
  /** Index of the box's bottom border. */
  bottom: number;
}

function boxFrame(prefix: string[]): BoxFrame | undefined {
  const borders = prefix.flatMap((row, i) => (BOX_BORDER_RE.test(row) ? [i] : []));
  const bottom = borders.at(-1);
  if (bottom === undefined) return undefined;
  const top = borders.at(-2);
  if (top === undefined) {
    // One border: the top of the box has scrolled off, so nothing of the
    // dialog can be above these rows. A rule up there is some other layout.
    if (prefix.slice(0, bottom).some((row) => SEPARATOR_RE.test(row))) return undefined;
    return { ruled: false, start: 0, header: [], rows: prefix.slice(0, bottom), whole: false, bottom };
  }
  let rule = top - 1;
  while (rule >= 0 && !SEPARATOR_RE.test(prefix[rule])) rule--;
  return { ruled: rule >= 0, start: rule + 1, header: prefix.slice(rule + 1, top), rows: prefix.slice(top + 1, bottom), whole: true, bottom };
}

/**
 * The row of the dialog's title, where the pane PROVES which row that is — and
 * with it that the dialog is on screen from its start, so that what the post
 * shows is the whole request. undefined: the pane does not show where the
 * dialog starts, and nothing about the rows it does show is taken on trust.
 *
 *  - Under the rule that opens every dialog. A rule on screen is the dialog's
 *    own: everything a request supplies is drawn indented (command,
 *    description, file content, reason — verified live with all of them made
 *    of rule characters), so no row inside a dialog starts with one, and with
 *    the dialog's rule off screen nothing above the dialog is on screen
 *    either.
 *  - With no rule on screen: as the pane's first row, above a whole command
 *    box, when that row is a Bash prompt's title BY ITS ATTRIBUTES — the words
 *    "Bash command" in bold. The words prove nothing by themselves (a
 *    description may read "Bash command", and be the first row because the
 *    real title, naming another requester, is one row off screen), and neither
 *    does a pending call that happens to fit the rows under them. A capture
 *    without attributes therefore never proves this case.
 *
 * Anything else — the pane starts inside the box, at its border, in the
 * description, below the box altogether, or in another tool's dialog — is not
 * shown from its start.
 */
function dialogTitleRow(prefix: string[], frame: BoxFrame | undefined, firstRowBold: string): number | undefined {
  const rules = prefix.flatMap((row, i) => (SEPARATOR_RE.test(row) ? [i] : []));
  if (rules.length > 0) {
    // With a command box on screen, the rule its title and description stand under.
    const rule = frame?.whole ? (frame.ruled ? frame.start - 1 : undefined) : rules.at(-1);
    return rule !== undefined && /^ \S/.test(prefix[rule + 1] ?? '') ? rule + 1 : undefined;
  }
  return frame?.whole && BASH_TITLE_ROW_RE.test(prefix[0] ?? '') && BASH_TITLE_BOLD_RE.test(firstRowBold) ? 0 : undefined;
}

interface Binding {
  /** The pending tool_uses that fit everything the dialog displays. */
  fits: OpenToolUse[];
  /** The dialog's title row is proven (dialogTitleRow) and is the hand's own. */
  titled: boolean;
  /** Index of the first row of the dialog's displayed identity (see PendingQ.shown). */
  start: number;
  /** One past its last row. */
  end: number;
}

/**
 * Which of the hand's pending Bash tool_uses could this dialog be asking
 * about? Every one that fits ALL the dialog displays of its request:
 *  - the command box shows the tool_use's command — the whole command when
 *    both dashed borders are on screen, its tail when the top border has
 *    scrolled off;
 *  - the description rows under the title show its description (or the end of
 *    it, where the title is not on screen);
 *  - the title is the hand's own "Bash command" (plus the place in the queue).
 * Returns undefined when the dialog is not recognisably the hand's own Bash
 * prompt, so that no pending call may be tied to it. The caller ties only on
 * exactly one fit: with several, which request is asking cannot be told.
 *
 * Whose request it is, is read off the TITLE ROW and nowhere else — a
 * description is the request's own prose and may say "· from the test run".
 * `titleAt` is that row where the pane proves it (dialogTitleRow); then the
 * rows between it and the box are the whole description. Where it is not
 * proven the prompt takes no answer anyway, and a fit — reading the rows above
 * the box as the end of the description, or as title plus description if the
 * first reads like the hand's own title — only gives its one post a stable
 * identity.
 *
 * The screen-reader layout is matched under its heading: description and
 * command lead the quoted block. It never takes answers (requiresTerminal).
 */
function bindBash(
  prefix: string[],
  frame: BoxFrame | undefined,
  ax: { title: string; start: number } | undefined,
  open: OpenToolUse[],
  titleAt: number | undefined,
): Binding | undefined {
  const bash = open.filter((u) => u.name === 'Bash' && typeof u.input.command === 'string');
  const described = (u: OpenToolUse): string[] => {
    const d = u.input.description;
    return typeof d === 'string' && d.trim() ? [squeeze(d)] : [squeeze(DEFAULT_BASH_DESCRIPTION), ''];
  };
  if (ax) {
    if (ax.title !== 'Bash command') return undefined;
    let end = ax.start;
    while (prefix[end]?.startsWith('>')) end++;
    const text = squeeze(prefix.slice(ax.start, end).map((row) => row.slice(1)).join(''));
    const fits = bash.filter((u) => described(u).some((d) => text.startsWith(d + squeeze(u.input.command as string))));
    return { fits, titled: true, start: ax.start - 1, end };
  }
  if (!frame) return undefined;
  const rows = ungutter(frame.rows);
  if (!rows || rows.length === 0) return undefined;
  const { header } = frame;
  const own = OWN_BASH_TITLE_RE.test(header[0] ?? '');
  const fit = (description: string[], whole: boolean): OpenToolUse[] => {
    const shown = ungutter(description);
    if (!shown) return [];
    const text = squeeze(shown.join(''));
    return bash.filter((u) =>
      boxShows(u.input.command as string, rows, frame.whole) && described(u).some((d) => (whole ? d === text : d.endsWith(text))));
  };
  const span = { start: frame.start, end: frame.bottom + 1 };
  if (titleAt !== undefined) {
    // The title row is known: it must be this box's, and the hand's own.
    return titleAt === frame.start && own ? { fits: fit(header.slice(1), true), titled: true, ...span } : undefined;
  }
  // Not shown from its start. A rule on screen without a title under it, or a
  // first row that reads as another requester's title, is not the hand's.
  if (frame.ruled || (!own && BASH_TITLE_ROW_RE.test(header[0] ?? ''))) return undefined;
  const underTitle = frame.whole && own && header.length > 1 ? fit(header.slice(1), true) : [];
  return { fits: [...underTitle, ...fit(header, false)], titled: false, ...span };
}

/** Parse a captured tmux pane for an open tool-permission prompt, anchored at
 *  the bottom of the pane — the dialog's own question, options and footer are
 *  always its last rows, whatever the command above them contains. Shape:
 *  separator · title · description · boxed command/diff · reason · optional
 *  expiry notice · "Do you want to …?" · numbered options · footer. */
function parsePermissionPane(lines: string[], bold: string[], open: OpenToolUse[]): PaneDialog {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  let qIdx = end - 1;
  while (qIdx >= 0 && !PERM_QUESTION_RE.test(lines[qIdx])) qIdx--;
  if (qIdx === -1) return { kind: 'none' };
  // An AskUserQuestion may well ask "Do you want to …?"; its last entry says whose dialog this is.
  if (lines.slice(qIdx + 1, end).some((row) => FOOTER_RE.test(row))) return { kind: 'none' };

  const options: { label: string }[] = [];
  let cursors = 0;
  let spaced = false;
  let i = qIdx + 1;
  while (i < end) {
    // The cursor list has its options on consecutive rows. While amending on
    // a narrow pane a blank row follows the text field: read on to the next
    // option so the post lists them all, but that is not the cursor list.
    let next = i;
    if (options.length > 0) while (next < end && !lines[next].trim()) next++;
    const m = next < end ? lines[next].match(OPTION_RE) : null;
    if (!m || (next > i && m[1] !== String(options.length + 1))) break;
    // The answer spec uses option indexes as key numbers; never renumber gaps.
    if (m[1] !== String(options.length + 1)) return { kind: 'none' };
    if (next > i) spaced = true;
    i = next;
    if (lines[i].trimStart().startsWith('❯')) cursors++;
    let label = m[2].trim();
    i++;
    // A wrapped label continues on rows indented under it.
    while (i < end && /^ {6,}\S/.test(lines[i]) && !OPTION_RE.test(lines[i])) label += ' ' + lines[i++].trim();
    options.push({ label });
  }
  if (options.length === 0) return { kind: 'none' };
  // The footer wraps on narrow panes and grows hints ("· Tab to amend",
  // "· ctrl+x ctrl+k twice to stop background agents"): read the block whole,
  // and ask only that it is there and what, if anything, stands before it.
  const tail = lines.slice(i, end).map((row) => row.trim()).filter(Boolean).join(' ').match(PERM_TAIL_RE);
  if (!tail) return { kind: 'none' };
  const [, instructions, footer] = tail;
  const axInput = AX_PERMISSION_INPUT_RE.test(instructions);
  // Digits select-and-submit only in the cursor list, and a cursor alone does
  // not make one: after Tab the same list is a text field ("1. Yes, and tell
  // Claude what to do next") where a digit is typed into the amendment. The
  // list's own footer hint is what tells them apart. Anything else — amending,
  // the screen-reader "then Enter" input, unknown instructions, no single
  // cursor — is posted for the terminal and never takes keys from here.
  const digitList = instructions === '' && cursors === 1 && !spaced && options.length <= 9 && DIGIT_LIST_FOOTER_RE.test(footer);

  // A heading-like row can be body text. Only the matching input layout
  // warrants cutting off the prefix; keep it when a boundary isn't clear.
  const prefix = lines.slice(0, qIdx);
  const headings = axInput
    ? prefix.flatMap((row, j) => (AX_PERMISSION_TITLE_RE.test(row) && prefix[j + 1]?.startsWith('> ') ? [j] : []))
    : [];
  const frame = axInput ? undefined : boxFrame(prefix);
  // Where the dialog starts, if the pane proves it; the rows from there down
  // are then the request, whole. Without that the post shows every row there
  // is, under no title of its own.
  const titleAt = axInput ? undefined : dialogTitleRow(prefix, frame, bold[0] ?? '');
  const titleIdx = axInput ? (headings.length === 1 ? headings[0] : -1) : titleAt ?? -1;
  const title = titleIdx >= 0 ? (axInput ? prefix[titleIdx].match(AX_PERMISSION_TITLE_RE)![1] : prefix[titleIdx].trim()) : undefined;

  const bound = bindBash(prefix, frame, axInput && titleIdx >= 0 ? { title: title!, start: titleIdx + 1 } : undefined, open, titleAt);
  const tie = bound?.fits.length === 1 ? bound.fits[0] : undefined;
  const lookalikes = bound && bound.fits.length > 1 ? bound.fits.map((u) => u.id) : undefined;
  // An answer from Zulip needs the right input mode, and a post that shows
  // what is being approved: the dialog from its proven title down. That holds
  // for every prompt, whether or not a pending call is offered as its
  // identity; and such a call must be the only one that fits.
  const terminalWhy = !digitList ? 'input'
    : titleAt === undefined || (tie && !bound!.titled) ? 'cut'
    : lookalikes ? 'lookalike'
    : undefined;
  return {
    kind: 'question',
    q: {
      kind: 'permission',
      title: title ?? 'Permission request',
      // What gets posted is what the dialog shows, tied or not.
      detail: prefix.slice(titleIdx + 1).join('\n'),
      ...(tie ? { toolUseId: tie.id } : {}),
      ...(lookalikes ? { lookalikes } : {}),
      ...(tie || lookalikes ? { shown: prefix.slice(bound!.start, bound!.end).join('\n') } : {}),
      question: lines[qIdx].trim(),
      multiSelect: false,
      options,
      ...(terminalWhy ? { requiresTerminal: true, terminalWhy } : {}),
    },
    ...(bound && bound.fits.length === 0 ? { awaitsToolUse: true } : {}),
  };
}

/** Parse a captured tmux pane for an open AskUserQuestion dialog or a tool
 *  permission prompt (both block the session; both are bridged). `pane` is the
 *  capture, best taken with attributes (`capture-pane -e`): a plain one cannot
 *  prove a title whose rule has scrolled off, and such a prompt is then for
 *  the terminal. `open` — the transcript's pending tool_uses — lets a Bash
 *  permission prompt be tied to the request it asks about; without it the
 *  prompt is identified by its rows. */
export function parseDialogPane(pane: string, open: OpenToolUse[] = []): PaneDialog {
  const { lines, bold } = readCapture(pane);
  const permission = parsePermissionPane(lines, bold, open);
  if (permission.kind !== 'none') return permission;

  // Both AskUserQuestion screens are matched by their own bottom rows, not by
  // marker text that a command or file shown in some other dialog may contain.
  const lastIdx = (re: RegExp): number => {
    for (let j = lines.length - 1; j >= 0; j--) if (re.test(lines[j])) return j;
    return -1;
  };
  // A permission prompt's own question is always below whatever it displays.
  const shown = lastIdx(PERM_QUESTION_RE);
  if (lastIdx(REVIEW_RE) > shown) return { kind: 'review' };
  const footerIdx = lastIdx(FOOTER_RE);
  if (footerIdx <= shown) return { kind: 'none' };

  // Tab bar (multi-part) or single-part header line ("☐ Fruit") above the body.
  let headerIdx = -1;
  let parts: string[] | undefined;
  for (let i = footerIdx - 1; i >= 0; i--) {
    if (TAB_BAR_RE.test(lines[i])) {
      headerIdx = i;
      if (lines[i].includes('Submit')) {
        parts = [...lines[i].matchAll(/[☐☒]\s+([^☐☒✔←→]+?)(?=\s{2,}|$)/g)].map((m) => m[1].trim());
      }
      break;
    }
  }

  const body = lines.slice(headerIdx + 1, footerIdx);
  const options: { label: string }[] = [];
  let textOptionIndex: number | undefined;
  let multiSelect = false;
  const questionLines: string[] = [];
  let sawOption = false;
  for (const line of body) {
    if (/^[─━-]{6,}\s*$/.test(line.trim())) continue;
    const m = line.match(OPTION_RE);
    if (m) {
      sawOption = true;
      let label = m[2];
      if (CHECKBOX_RE.test(label)) {
        multiSelect = true;
        label = label.replace(CHECKBOX_RE, '');
      }
      if (TYPE_SOMETHING_RE.test(label.trim())) {
        textOptionIndex = parseInt(m[1], 10);
      } else {
        options.push({ label: label.trim() });
      }
    } else if (!sawOption && line.trim()) {
      questionLines.push(line.trim());
    }
    // Indented description lines under options are ignored — labels suffice.
  }
  if (!sawOption || options.length === 0) return { kind: 'none' };
  return {
    kind: 'question',
    q: { question: questionLines.join(' ').trim(), multiSelect, options, textOptionIndex },
    parts,
  };
}

/** Identity of a displayed question: a changed sig means a different request
 *  (or the dialog's next part) is on screen. */
export function dialogSig(q: PendingQ): string {
  // The options stay in every form: an answer is a key number, and it must
  // mean what the post said it means.
  // Tied: the pending call plus the dialog's rows from title to the end of its
  // box — queue position and description included, the reason and countdown
  // under the box not.
  if (q.toolUseId) return JSON.stringify(['tool_use', q.toolUseId, q.shown, q.question, q.options.map((o) => o.label), !!q.requiresTerminal]);
  // Several calls fit: no request is identified, the set only keeps this
  // terminal-only post from being repeated while a countdown ticks.
  if (q.lookalikes) return JSON.stringify(['tool_uses', q.lookalikes, q.shown, q.question, q.options.map((o) => o.label)]);
  if (q.kind === 'permission' && q.requiresTerminal) {
    // A notification, not a request anyone can answer from here: it is the
    // same notification while the rows read the same, the clock of an expiry
    // notice aside. (Two requests that differ in nothing else on screen get
    // one post; no key is sent on the strength of this.)
    const detail = maskExpiryClock(q.detail ?? '', q.terminalWhy === 'cut');
    return JSON.stringify(['permission', 'terminal', q.terminalWhy, q.title, detail, q.question, q.options.map((o) => o.label)]);
  }
  if (q.kind === 'permission') {
    // Not tied to a tool_use: every row above the question is the identity
    // (unambiguous even with delimiter-like content) — a countdown included.
    return JSON.stringify(['permission', q.title, q.detail, q.question, q.options.map((o) => o.label), false]);
  }
  return [q.kind ?? 'question', q.title ?? '', q.detail ?? '', q.question, ...q.options.map((o) => o.label)].join('§');
}

const EXPIRY_PREFIX_RE = /(?:^|\n) *⚠\s+Claude\s+Code\s+will\s+automatically\s+(?:block|deny)\s+this\s+request\s+in\s+$/;
const EXPIRY_END_RE = /(\d+:\d\d|(?:about\s+)?\d+\s+(?:minutes?|seconds?)),\s+to\s+avoid\s+(holding\s+up|blocking\s+progress\s+on)\s+an\s+unattended\s+session(?=\n*$)/;

/** The expiry notice ends just above the question (the end of detail).
 *  For a cut prompt, the entire visible detail can also be the tail of a
 *  known notice: it starts at the pane edge, possibly on the clock itself.
 *  Match across wraps, but change only the clock in the signature. */
function maskExpiryClock(detail: string, cut: boolean): string {
  const notice = EXPIRY_END_RE.exec(detail);
  if (!notice) return detail;
  const before = detail.slice(0, notice.index);
  if (!EXPIRY_PREFIX_RE.test(before)) {
    // Every warning row starts at the one-space margin. A partial notice
    // cannot follow other detail rows as a whole notice can.
    if (!cut || !/^ (?:\S[^\n]*\n )*(?:\S[^\n]* )?$/.test(before)) return detail;
    const verb = collapse(notice[2]) === 'holding up' ? 'block' : 'deny';
    const prefix = `⚠ Claude Code will automatically ${verb} this request in`;
    if (before !== ' ' && !prefix.endsWith(' ' + collapse(before))) return detail;
  }
  return before + '…' + detail.slice(notice.index + notice[1].length);
}

const POST_BUDGET = 9000; // Zulip's limit is 10000

/** Render the dialog as a topic post. Explicit about the one thing observers
 *  get wrong: the hand cannot read Zulip right now — talking to it in natural
 *  language goes nowhere; answers must go through the spawner. */
export function formatQuestionPost(entry: BotEntry, pending: PendingQuestion, spawner: string, target = canonicalHandTarget(entry)): string {
  const q = pending.questions[0];
  if (q.kind === 'permission') return formatPermissionPost(entry, q, spawner, target);
  const partsNote =
    pending.parts && pending.parts.length > 1
      ? `\n*(part of a ${pending.parts.length}-question dialog — ${pending.parts.join(', ')} — I'll post each part as it comes up)*`
      : '';
  const parts: string[] = [
    `❓ **${entry.personaName}** is asking a multiple-choice question — its session is **blocked on a dialog and cannot see Zulip**. 🤖 Answering in natural language will NOT work (that includes other models): answers must go through me, via @-mention:`,
    `\`@**${spawner}** answer ${target} <choice>\` — a number (\`2\`)${q.multiSelect ? ', several (`1,3`)' : ''}, custom text (\`text: …\`), or \`esc\` to dismiss. In this topic, \`@**${spawner}** <choice>\` is enough.`,
    `**${q.question}**${q.multiSelect ? ' *(pick any)*' : ''}${partsNote}`,
  ];
  for (const [i, opt] of q.options.entries()) parts.push(`> ${i + 1}. **${opt.label}**`);
  const post = parts.join('\n');
  return post.length > POST_BUDGET ? post.slice(0, POST_BUDGET - 1) + '…' : post;
}

const DETAIL_BUDGET = 4000;

/** Why a prompt is not answered from Zulip, for its post. */
const TERMINAL_ONLY: Record<NonNullable<PendingQ['terminalWhy']>, string> = {
  input: 'This permission prompt requires terminal input; use the terminal to respond.',
  cut: "The top of this prompt is off the hand's screen — its terminal is too short for it — so I cannot show the whole request or whose it is, and will not pass on an answer to it. " +
    'What follows is only the part on screen. This permission prompt requires terminal input; read it and respond there.',
  lookalike: 'Several pending requests of this hand look exactly like this one, so I cannot tell which of them is asking and will not pass on an answer. ' +
    'This permission prompt requires terminal input; respond there.',
};

/** A tool permission prompt: show the command/diff and how to use its options. */
function formatPermissionPost(entry: BotEntry, q: PendingQ, spawner: string, target = canonicalHandTarget(entry)): string {
  // Too long for a post: keep both ends — what a command finally does is as
  // often at its tail as at its head — and say what is missing.
  const block = (text: string, budget: number) => {
    const head = Math.floor(budget * 0.6);
    const cut = text.length > budget
      ? `${text.slice(0, head)}\n[… ${text.length - budget} characters not shown here — see the terminal …]\n${text.slice(head - budget)}`
      : text;
    return '```\n' + cut.replace(/```/g, "'''") + '\n```';
  };
  const detail = (q.detail ?? '').replace(/^\n+/, '').trimEnd();
  const parts: string[] = [
    `🔐 **${entry.personaName}** is waiting on a permission prompt — its session is **blocked on a dialog and cannot see Zulip**. 🤖 Natural-language replies will NOT reach it (other models included).`,
    q.requiresTerminal
      ? TERMINAL_ONLY[q.terminalWhy ?? 'input']
      : `Answer with the displayed option number: \`@**${spawner}** answer ${target} <number>\`. In this topic, \`@**${spawner}** <number>\` is enough. Use \`esc\` to dismiss.`,
    `**${collapse(q.title ?? 'Permission request')}**`,
  ];
  // As the terminal showed it when this was posted — a countdown in it counts
  // from the post's time. Nothing here comes from the hand's transcript.
  if (detail) parts.push(block(detail, DETAIL_BUDGET));
  parts.push(`**${q.question}**`);
  for (const [i, opt] of q.options.entries()) parts.push(`> ${i + 1}. **${opt.label}**`);
  const post = parts.join('\n');
  return post.length > POST_BUDGET ? post.slice(0, POST_BUDGET - 1) + '…' : post;
}

// ── Answer parsing ──

export type ParsedAnswer =
  | { kind: 'esc' }
  | { kind: 'digits'; nums: number[] }
  | { kind: 'text'; text: string }
  | { kind: 'error'; error: string };

const DIGITS_RE = /^\d+(\s*,\s*\d+)*$/;

/** Parse an answer spec against the displayed question. */
export function parseAnswerSpec(body: string, q: PendingQ): ParsedAnswer {
  const spec = body.trim();
  if (!spec) return { kind: 'error', error: 'empty answer' };
  if (/^(esc|escape|dismiss|cancel)$/i.test(spec)) return { kind: 'esc' };
  const textMatch = spec.match(/^text:\s*(.*)$/is);
  if (textMatch) {
    const text = textMatch[1].trim();
    return text ? { kind: 'text', text } : { kind: 'error', error: 'empty custom text' };
  }
  if (DIGITS_RE.test(spec)) {
    const nums = [...new Set(spec.split(',').map((n) => parseInt(n.trim(), 10)))];
    const bad = nums.find((n) => n < 1 || n > q.options.length);
    if (bad !== undefined) {
      return { kind: 'error', error: `option ${bad} is out of range (1-${q.options.length})` };
    }
    if (!q.multiSelect && nums.length !== 1) {
      return { kind: 'error', error: 'this question is single-choice — give exactly one number' };
    }
    return { kind: 'digits', nums };
  }
  // A bare word that names an option (exactly, or as a unique prefix —
  // `yes` → "Yes", `no` → "No") selects it; permission prompts have no
  // free-text entry so this is the only non-numeric form that works there.
  const lc = spec.toLowerCase();
  const exact = q.options.findIndex((o) => o.label.toLowerCase() === lc);
  if (exact !== -1) return { kind: 'digits', nums: [exact + 1] };
  const synonyms: Record<string, string> = { y: 'yes', ok: 'yes', allow: 'yes', approve: 'yes', proceed: 'yes', n: 'no', deny: 'no', reject: 'no' };
  const needle = synonyms[lc] ?? lc;
  const prefixed = q.options.map((o, i) => ({ o, i })).filter(({ o }) => o.label.toLowerCase().startsWith(needle));
  if (prefixed.length === 1 && /^[a-z]/.test(needle)) return { kind: 'digits', nums: [prefixed[0].i + 1] };
  if (q.kind === 'permission') {
    return { kind: 'error', error: `pick an option by number (1-${q.options.length}), \`yes\`/\`no\`, or \`esc\`` };
  }
  // Bare non-numeric answer = custom text.
  return { kind: 'text', text: spec };
}

// ── Injection ──

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KEY_SETTLE_MS = 350;

/** Keys reached the terminal and then a later one failed: the answer was
 *  neither delivered nor withheld. `sent` is what did go. */
export class PartialAnswerError extends Error {
  constructor(message: string, readonly sent: string[]) {
    super(message);
  }
}

/**
 * Drive the currently displayed question in the bot's tmux pane. Throws with an
 * operator-readable message if the expected dialog isn't on screen — before any
 * key, so a throw means nothing was sent (PartialAnswerError apart). The
 * transcript watcher provides the ground-truth confirmation (the tool_use +
 * tool_result pair lands when the whole dialog resolves) — this only pushes
 * keys. `read` returns the dialog on screen now, identified the same way the
 * posted one was (the watcher's reader ties Bash prompts to the transcript and
 * looks at the screen last, after its transcript I/O); nothing but this
 * comparison stands between that look and the key.
 *
 * Once the keys are out they are out: failing to look at the screen
 * afterwards is reported as a note on a sent answer, never as a failure to
 * deliver it.
 */
export async function injectAnswer(
  tmux: Tmux,
  tmuxSession: string,
  expected: PendingQuestion,
  parsed: ParsedAnswer,
  read: () => Promise<PaneDialog> = async () => parseDialogPane(await tmux.capturePane(tmuxSession, 0, true)),
): Promise<string | undefined> {
  const dialog = await read();
  if (dialog.kind === 'none') {
    throw new Error(
      'no question dialog is on screen (already answered in the terminal, or the session moved on) — `rescan` to refresh',
    );
  }
  if (dialog.kind === 'review') {
    throw new Error('the dialog is on its final review screen — `rescan` to refresh, or answer `1` after it reposts');
  }
  if (dialogSig(dialog.q) !== expected.sig) {
    throw new Error('the dialog moved on to a different question — `rescan` to repost the current one');
  }
  const q = dialog.q;
  if (q.requiresTerminal) {
    throw new Error('this permission prompt requires terminal input — no keys sent; respond in the terminal');
  }
  if (parsed.kind === 'text' && q.textOptionIndex === undefined) throw new Error('this dialog has no free-text entry — pick a number');
  if (parsed.kind === 'error') throw new Error('unparsed answer'); // guarded by caller

  const sent: string[] = [];
  const key = async (name: string) => {
    await tmux.sendKeys(tmuxSession, name);
    sent.push(name);
  };
  try {
    if (parsed.kind === 'esc') {
      await key('Escape');
      return undefined;
    }
    if (parsed.kind === 'digits') {
      for (const n of parsed.nums) {
        await key(String(n));
        await sleep(KEY_SETTLE_MS);
      }
      // multiSelect digits only toggle — advance explicitly. Single-select
      // auto-advances (and auto-submits when it's the only question).
      if (q.multiSelect) await key('Tab');
    } else {
      await key(String(q.textOptionIndex));
      await sleep(KEY_SETTLE_MS);
      await tmux.sendText(tmuxSession, parsed.text);
      sent.push('the text');
      await sleep(KEY_SETTLE_MS);
      await key('Enter');
    }
  } catch (err) {
    if (sent.length === 0) throw err;
    throw new PartialAnswerError((err as Error).message, sent);
  }

  // Single-question dialogs are done; multi-part ones either show the next
  // question (the watcher reposts it) or the review screen — confirm that.
  await sleep(700);
  let after: PaneDialog;
  try {
    after = await read();
  } catch (err) {
    return `I could not look at its screen afterwards (${(err as Error).message}) — \`rescan\` to see what is open now.`;
  }
  if (after.kind === 'review' && q.kind !== 'permission') {
    try {
      await tmux.sendKeys(tmuxSession, '1');
    } catch {
      return 'the dialog is on its final review screen and I could not confirm it — `rescan`, then answer `1`.';
    }
    return undefined;
  }
  if (after.kind === 'question' && dialogSig(after.q) === expected.sig) {
    return `the dialog is still showing the same question after my keystrokes — check \`peek\` or tmux attach -t ${tmuxSession}`;
  }
  if (q.kind === 'permission' && after.kind !== 'none') {
    return 'a different dialog is now on screen.';
  }
  if (after.kind === 'question') {
    return 'that part is answered — the dialog moved to its next question, posting it here shortly.';
  }
  return undefined;
}
