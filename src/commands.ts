/**
 * Command grammar and validation (ported from cc-spawner, codex removed).
 *
 * Text grammar, over the message body with leading @-mentions stripped:
 *   spawn <model> [name=<friendly>] [effort=<level>]
 *   list
 *   stop <name>            (alias: kill)
 *   peek <name> [lines]    (always answered by DM)
 *   answer <name> <choice>
 *   press <name> <keys…>
 *   rescan
 *   help
 */
export type Command =
  | { kind: 'spawn'; model: string; friendly?: string; effort?: string }
  | { kind: 'list' }
  | { kind: 'stop'; target: string }
  | { kind: 'peek'; target: string; lines?: number }
  | { kind: 'answer'; target: string; spec: string }
  | { kind: 'press'; target: string; keys: string[] }
  | { kind: 'rescan' }
  | { kind: 'help'; error?: string; unknownVerb?: boolean };

// Model ids may be dotted ids or provider paths (bedrock ids with : and /).
// Always single-quoted into the shell later.
const MODEL_RE = /^[A-Za-z0-9._:@/-]+$/;
const FRIENDLY_RE = /^[A-Za-z0-9-]{1,24}$/;

/**
 * `--effort` levels; `ultracode` = xhigh + standing workflow orchestration.
 * The CLI does not reject a bad value at launch (it warns and falls back), so
 * the spawner validates.
 */
export const EFFORT_LEVELS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
/** `effort=default` passes no flag and drops an effort inherited on revival. */
export const EFFORT_DEFAULT = 'default';

// Models the CLI silently clamps or drops effort on (upstream, claude 2.1.286):
// no xhigh (which ultracode also needs): 3.x, Opus 4.0/4.1/4.5/4.6, Sonnet 4.x, Haiku 4.5.
const NO_ULTRACODE_RE = /claude-3|haiku-[34]|sonnet-4|opus-4(?:-[0156])?(?:-\d{8})?(?![-.]?\d)/i;
// No max: Opus 4.0/4.1/4.5.
const NO_MAX_RE = /opus-4(?:-[015])?(?:-\d{8})?(?![-.]?\d)/i;
// No effort parameter at all: 3.x, Sonnet 4.0/4.5, Haiku 3.x/4.5.
const NO_EFFORT_RE = /claude-3-|haiku-[34]|sonnet-4(?:-[05])?(?:-\d{8})?(?![-.]?\d)/i;

export function effortError(effort: string, model: string): string | undefined {
  if (effort === EFFORT_DEFAULT) return undefined;
  const valid = `${EFFORT_LEVELS.map((l) => `\`${l}\``).join(', ')}, or \`${EFFORT_DEFAULT}\``;
  if (!EFFORT_LEVELS.includes(effort)) return `effort \`${effort}\` not supported — ${valid}`;
  if (NO_EFFORT_RE.test(model)) return `\`${model}\` has no effort setting — drop \`effort=\``;
  if (effort === 'ultracode' && NO_ULTRACODE_RE.test(model)) {
    return `effort \`ultracode\` is not available on \`${model}\` — pick a 5.x model (or Opus 4.7/4.8), or a plain level`;
  }
  if ((effort === 'xhigh' && NO_ULTRACODE_RE.test(model)) || (effort === 'max' && NO_MAX_RE.test(model))) {
    return `effort \`${effort}\` is not available on \`${model}\` — the CLI would silently run it at \`high\`; pick \`high\` or a newer model`;
  }
  return undefined;
}

export const USAGE = [
  'Usage (mention me):',
  '`spawn <model> [name=<friendly>] [effort=<level>]` — spawn a hand whose home is this stream + topic (model explicit: fable-5-1, opus-5-5, sonnet-5-5, haiku-4-5, … or a full id; effort: low, medium, high, xhigh, max, ultracode — kept across revivals, `effort=default` clears it)',
  '`list` — show running hands',
  '`stop <name>` — stop a hand (identity and conversation are kept; `spawn` the same model + name revives it)',
  '`peek <name> [lines]` — DM yourself the hand\'s terminal tail (default 20 lines)',
  '`answer <name> <choice>` — answer a hand\'s pending question or permission prompt (`2`, `1,3`, `yes`/`no`, `text: …`, or `esc`)',
  '`press <name> <keys…>` — raw keystrokes into a hand\'s terminal (`press scout 1 enter`; keys: digits, `enter`, `esc`, `tab`, `up`/`down`, `ctrl-c`, or literal text)',
  '`rescan` — re-check every hand for an open question dialog and (re)post it',
].join('\n');

/**
 * Explicit model names → ids passed to `claude --model`. Bare family aliases
 * are refused: the CLI re-points them on upgrade, and the model token is part
 * of the hand's name — a name must keep meaning one model.
 */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  'fable-5-1': 'claude-fable-5-1',
  'fable-5': 'claude-fable-5',
  'opus-5-5': 'claude-opus-5-5',
  'opus-5': 'claude-opus-5',
  'opus-4-8': 'claude-opus-4-8',
  'opus-4-7': 'claude-opus-4-7',
  'opus-4-6': 'claude-opus-4-6',
  'sonnet-5-5': 'claude-sonnet-5-5',
  'sonnet-5': 'claude-sonnet-5',
  'sonnet-4-6': 'claude-sonnet-4-6',
  'haiku-5-5': 'claude-haiku-5-5',
  'haiku-4-5': 'claude-haiku-4-5',
};
export const MODEL_CHOICES = Object.keys(MODEL_ALIASES);

const BARE_FAMILY_RE = /^(fable|opus|sonnet|haiku|best|opusplan)(\[1m\])?$/i;
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

/** `fable5.1` / `Fable-5.1` / `opus55` → `fable-5-1` / `opus-5-5`. */
function normalizeAlias(model: string): string {
  const m = model.toLowerCase().match(/^([a-z]+)[-.]?(\d)(?:[-.]?(\d))?$/);
  if (m && FAMILIES.includes(m[1])) return `${m[1]}-${m[2]}${m[3] ? `-${m[3]}` : ''}`;
  return model.toLowerCase();
}

export function resolveModel(model: string): string {
  return MODEL_ALIASES[normalizeAlias(model)] ?? model;
}

export function isBareFamilyAlias(model: string): boolean {
  return BARE_FAMILY_RE.test(model);
}

/**
 * Short, name-safe token for a model id: claude-opus-4-8 → opus-4-8,
 * global.anthropic.claude-sonnet-4-5 → sonnet-4-5. Kept short: it is part of
 * the bot's Zulip name and email.
 */
export function modelSlug(model: string): string {
  let s = model.toLowerCase();
  s = s.split('/').pop() ?? s;
  s = s.split(':').pop() ?? s;
  s = s.replace(/^.*\banthropic\./, '');
  s = s.replace(/^claude-?/, '');
  s = s.replace(/-\d{8}$/, '');
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 12).replace(/-+$/, '') || 'model';
}

export function buildSpawnCommand(model: string | undefined, friendly?: string, effort?: string): Command {
  if (friendly !== undefined && !FRIENDLY_RE.test(friendly)) {
    return { kind: 'help', error: `bad name \`${friendly}\` — use 1-24 chars of [A-Za-z0-9-]` };
  }
  if (!model) return { kind: 'help', error: 'model is required — e.g. `spawn opus-5-5`, `spawn sonnet-5-5 name=scout`' };
  if (!MODEL_RE.test(model)) return { kind: 'help', error: `bad model \`${model}\`` };
  if (isBareFamilyAlias(model)) {
    return {
      kind: 'help',
      error: `bare \`${model}\` is refused — say which version: ${MODEL_CHOICES.map((c) => `\`${c}\``).join(', ')}, or a full id like \`claude-opus-5-5\``,
    };
  }
  const resolved = resolveModel(model);
  const error = effort === undefined ? undefined : effortError(effort, resolved);
  if (error) return { kind: 'help', error };
  return { kind: 'spawn', model: resolved, friendly, effort };
}

export function buildStopCommand(target: string | undefined): Command {
  if (!target) return { kind: 'help', error: 'stop needs a target — `stop <name>`' };
  return { kind: 'stop', target };
}

export const PEEK_DEFAULT_LINES = 20;
export const PEEK_MAX_LINES = 400;

export function buildPeekCommand(target: string | undefined, lines?: number | string): Command {
  if (!target) return { kind: 'help', error: 'peek needs a target — `peek <name>`' };
  if (lines === undefined || lines === '') return { kind: 'peek', target };
  const n = typeof lines === 'number' ? lines : Number(lines);
  if (!Number.isInteger(n) || n < 1 || n > PEEK_MAX_LINES) {
    return { kind: 'help', error: `lines must be a whole number from 1 to ${PEEK_MAX_LINES}` };
  }
  return { kind: 'peek', target, lines: n };
}

export function buildAnswerCommand(target: string | undefined, spec: string | undefined): Command {
  if (!target) return { kind: 'help', error: 'answer needs a target — `answer <name> <choice>`' };
  if (!spec || !spec.trim()) {
    return { kind: 'help', error: 'answer needs a choice — a number (`2`), `1,3`, `text: …`, or `esc`' };
  }
  return { kind: 'answer', target, spec: spec.trim() };
}

const PRESS_MAX_KEYS = 20;

export function buildPressCommand(target: string | undefined, keys: string | undefined): Command {
  if (!target) return { kind: 'help', error: 'press needs a target — `press <name> <keys…>`' };
  const list = (keys ?? '').trim().split(/\s+/).filter(Boolean);
  if (list.length === 0) return { kind: 'help', error: 'press needs keys — e.g. `press scout 1 enter` or `press scout esc`' };
  if (list.length > PRESS_MAX_KEYS) return { kind: 'help', error: `at most ${PRESS_MAX_KEYS} keys per press` };
  return { kind: 'press', target, keys: list };
}

/** Zulip mention tokens as they appear in raw markdown: @**Name**, @**Name|42**, @_**Name** (silent). */
const MENTION_RE = /^@_?\*\*[^*]+\*\*/;

/** Strip leading @-mentions and surrounding whitespace. */
export function stripMentions(content: string): string {
  let s = content.trim();
  for (;;) {
    const m = s.match(MENTION_RE);
    if (!m) break;
    s = s.slice(m[0].length).replace(/^[\s,:]+/, '');
  }
  return s.trim();
}

/** Parse a message body (mentions already stripped). */
export function parseCommand(body: string): Command {
  const tokens = body.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: 'help' };
  const verb = tokens[0].toLowerCase();

  // Fixed-arity commands refuse trailing text: "stop scout, then …" in a
  // conversational message must not run as a command.
  const extra = (n: number): Command | undefined =>
    tokens.length > n ? { kind: 'help', error: `unexpected text after \`${tokens.slice(0, n).join(' ')}\`` } : undefined;

  switch (verb) {
    case 'spawn': {
      let model: string | undefined;
      let friendly: string | undefined;
      let effort: string | undefined;
      for (const tok of tokens.slice(1)) {
        const kv = tok.match(/^([a-z]+)=(.*)$/);
        if (kv) {
          const [, key, value] = kv;
          if (key === 'name') friendly = value;
          else if (key === 'effort') effort = value.toLowerCase();
          else if (key === 'model') model = value;
          else return { kind: 'help', error: `unknown option \`${key}=\`` };
        } else if (!model) {
          model = tok;
        } else {
          return { kind: 'help', error: `unexpected token \`${tok}\`` };
        }
      }
      return buildSpawnCommand(model, friendly, effort);
    }
    case 'list':
      return extra(1) ?? { kind: 'list' };
    case 'stop':
    case 'kill':
      return extra(2) ?? buildStopCommand(tokens[1]);
    case 'peek':
      return extra(3) ?? buildPeekCommand(tokens[1], tokens[2]);
    case 'answer': {
      // The spec is free text — take the raw remainder after the target token.
      const afterVerb = body.trim().slice(tokens[0].length).trim();
      const target = afterVerb.split(/\s+/)[0];
      const spec = afterVerb.slice(target?.length ?? 0).trim();
      return buildAnswerCommand(target || undefined, spec || undefined);
    }
    case 'press':
    case 'keys':
      return buildPressCommand(tokens[1], tokens.slice(2).join(' '));
    case 'rescan':
    case 'scan':
      return extra(1) ?? { kind: 'rescan' };
    case 'help':
      return { kind: 'help' };
    default:
      return { kind: 'help', error: `unknown command \`${verb}\``, unknownVerb: true };
  }
}
