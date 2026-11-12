/**
 * Command grammar and validation (ported from cc-spawner).
 *
 * Text grammar, over the message body with leading @-mentions stripped:
 *   spawn <model> [name=<friendly>] [effort=<level>]
 *   model <hand> [<model>] [effort=<level>]
 *   models                (also: help models)
 *   list
 *   stop <name>            (alias: kill)
 *   peek <name> [lines]    (always answered by DM)
 *   answer <name> <choice>
 *   press <name> <keys…>
 *   rescan
 *   help
 */
export type Command =
  | { kind: 'spawn'; model: string; friendly?: string; effort?: string; engine?: 'claude' | 'codex' }
  | { kind: 'model'; target: string; model?: string; effort?: string }
  | { kind: 'models' }
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

type Engine = 'claude' | 'codex';
interface ModelCapability {
  label: string;
  engine: Engine;
  matches: (model: string) => boolean;
  efforts: readonly string[];
  /** Advisory only: Codex compatibility is decided by the CLI. */
  upstreamMax?: string;
}
const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** Ordered, first match per engine. Preserve the existing Claude pattern rules. */
export const MODEL_CAPABILITIES: readonly ModelCapability[] = [
  // Relayed upstream codex PR #761 capability data; not independently verified.
  ...([
    ['gpt-6-astra', 'ultra'], ['gpt-5.6-sol', 'ultra'], ['gpt-5.6-terra', 'ultra'],
    ['gpt-5.6-luna', 'max'], ['gpt-5.5', 'xhigh'], ['gpt-5.4-mini', 'xhigh'],
  ] as const).map(([model, upstreamMax]) => ({
    label: model, engine: 'codex' as const,
    matches: (id: string) => id.toLowerCase() === model,
    efforts: CODEX_EFFORTS, upstreamMax,
  })),
  // Local packaged CLI/help does not establish unsupported-model behaviour.
  // Never enforce a ceiling, listed or not (including explicit engine=codex).
  { label: 'Other gpt-* / other ids with engine=codex', engine: 'codex',
    matches: () => true, efforts: CODEX_EFFORTS },
  { label: 'Claude 3.x / Haiku 3.x, 4.5 / Sonnet 4.0, 4.5',
    engine: 'claude', matches: (id) => NO_EFFORT_RE.test(id), efforts: [] },
  { label: 'Opus 4.0, 4.1, 4.5', engine: 'claude',
    matches: (id) => NO_ULTRACODE_RE.test(id) && NO_MAX_RE.test(id),
    efforts: EFFORT_LEVELS.filter((e) => !['xhigh', 'max', 'ultracode'].includes(e)) },
  { label: 'Opus 4.6 / remaining Sonnet 4.x', engine: 'claude',
    matches: (id) => NO_ULTRACODE_RE.test(id),
    efforts: EFFORT_LEVELS.filter((e) => !['xhigh', 'ultracode'].includes(e)) },
  { label: 'Other Claude/full ids', engine: 'claude', matches: () => true, efforts: EFFORT_LEVELS },
];

export function modelCapability(model: string, engine?: Engine): ModelCapability {
  const selected = engine ?? (/^gpt-/i.test(model) ? 'codex' : 'claude');
  return MODEL_CAPABILITIES.find((row) => row.engine === selected && row.matches(model))!;
}

export function effortError(effort: string, model: string, engine?: Engine): string | undefined {
  if (effort === EFFORT_DEFAULT) return undefined;
  const capability = modelCapability(model, engine);
  if (capability.engine === 'codex') return capability.efforts.includes(effort) ? undefined : `effort \`${effort}\` is not available on \`${model}\` — Codex efforts: ${capability.efforts.join(', ')}, or default.`;
  const valid = `${EFFORT_LEVELS.map((l) => `\`${l}\``).join(', ')}, or \`${EFFORT_DEFAULT}\``;
  if (!EFFORT_LEVELS.includes(effort)) return `effort \`${effort}\` not supported — ${valid}`;
  if (capability.efforts.includes(effort)) return undefined;
  if (capability.efforts.length === 0) return `\`${model}\` has no effort setting — drop \`effort=\``;
  if (effort === 'ultracode') {
    return `effort \`ultracode\` is not available on \`${model}\` — pick a 5.x model (or Opus 4.7/4.8), or a plain level`;
  }
  return `effort \`${effort}\` is not available on \`${model}\` — the CLI would silently run it at \`high\`; pick \`high\` or a newer model`;
}

export const USAGE = [
  'Usage (mention me):',
  '`spawn <model> [name=<friendly>] [effort=<level>] [engine=codex|claude]` — spawn a hand whose home is this stream + topic (model explicit: fable-5-1, opus-5-5, sonnet-5-5, haiku-4-5, … or a full id; Claude effort: low, medium, high, xhigh, max, ultracode — kept across revivals, `effort=default` clears it)',
  'Codex: `gpt-*` → `codex` CLI; other ids → `claude`. Override with `engine=codex|claude`. Display names: `[cx-<model>] <name>` (Claude: `[cc-<model>] <name>`); new bot emails/tmux/workdirs use only `cx-<name>` / `cc-<name>`.',
  `Codex efforts: ${[...new Set(MODEL_CAPABILITIES.filter((r) => r.engine === 'codex').flatMap((r) => r.efforts))].join(', ')} (passed through; model-dependent).`,
  '`model <hand> [<model>] [effort=...]` — live same-engine switch (creator/owner only); omit model to list the live menu',
  '`models` (or `help models`) — aliases, full ids, CLIs, allowed efforts and default behaviour',
  '`list` — show running hands',
  '`stop <name>` — stop a hand (identity and conversation are kept; `spawn` the same name revives it, optionally with a new home/model)',
  '`peek <name> [lines]` — DM yourself the hand\'s terminal tail (default 20 lines)',
  '`answer <name> <choice>` — answer a hand\'s pending question or permission prompt (`2`, `1,3`, `yes`/`no`, `text: …`, or `esc`)',
  '`press <name> <keys…>` — raw keystrokes into a hand\'s terminal (`press scout 1 enter`; keys: digits, `enter`, `esc`, `tab`, `up`/`down`, `ctrl-c`, or literal text)',
  '`rescan` — re-check every hand for an open question dialog and (re)post it',
].join('\n');

/**
 * Explicit model names → ids passed to `claude --model`. Bare family aliases
 * are refused: the CLI re-points them on upgrade; launches must be explicit.
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

/** Human-readable listing uses the same capability rows as validation. */
export function modelsListing(): string {
  const format = (label: string, row: ModelCapability) =>
    `* ${label} — ${row.engine}: ${[...row.efforts, EFFORT_DEFAULT].join(', ')}${row.engine === 'codex' ? ' — passed to codex (model-dependent)' : ''}${row.upstreamMax ? `; advisory: up to ${row.upstreamMax} (upstream data; higher passed through, codex decides)` : ''}`;
  return [
    'Models → CLI: allowed efforts (patterns below are first-match per CLI).',
    ...Object.entries(MODEL_ALIASES).map(([alias, id]) => format(`\`${alias}\` → \`${id}\``, modelCapability(id))),
    ...MODEL_CAPABILITIES.map((row) => format(row.label, row)),
    '`default` = CLI-selected effort (no override); clears stored effort on revival. Omitted effort inherits on revival. Model must be explicit; no default model.',
  ].join('\n');
}

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

export function buildSpawnCommand(model: string | undefined, friendly?: string, effort?: string, engine?: 'claude' | 'codex'): Command {
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
  const error = effort === undefined ? undefined : effortError(effort, resolved, engine);
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
  const tokens: string[] = body.match(/@_?\*\*[^*]+\*\*|\[[a-z0-9-]+\]\s+[A-Za-z0-9-]+|\S+/gi) ?? [];
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
      let engine: 'claude' | 'codex' | undefined;
      for (const tok of tokens.slice(1)) {
        const kv = tok.match(/^([a-z]+)=(.*)$/);
        if (kv) {
          const [, key, value] = kv;
          if (key === 'engine') {
            if (value !== 'claude' && value !== 'codex') return { kind: 'help', error: 'engine must be claude or codex' };
            engine = value;
          }
          else if (key === 'name') friendly = value;
          else if (key === 'effort') effort = value.toLowerCase();
          else if (key === 'model') model = value;
          else return { kind: 'help', error: `unknown option \`${key}=\`` };
        } else if (!model) {
          model = tok;
        } else {
          return { kind: 'help', error: `unexpected token \`${tok}\`` };
        }
      }
      const command = buildSpawnCommand(model, friendly, effort, engine);
      return command.kind === 'spawn' && engine ? { ...command, engine } : command;
    }
    case 'model': {
      if (!tokens[1]) return { kind: 'help', error: 'model needs a hand — `model <hand> [<model>] [effort=...]`' };
      let model: string | undefined;
      let effort: string | undefined;
      for (const token of tokens.slice(2)) {
        if (token.startsWith('effort=') && effort === undefined) effort = token.slice(7).toLowerCase();
        else if (!model && MODEL_RE.test(token) && !token.includes('=')) model = token;
        else return { kind: 'help', error: `unexpected token \`${token}\`` };
      }
      if (model) {
        const validated = buildSpawnCommand(model, undefined, effort);
        if (validated.kind !== 'spawn') return validated;
        model = validated.model;
      } else if (effort !== undefined && ![...EFFORT_LEVELS, ...CODEX_EFFORTS, EFFORT_DEFAULT].includes(effort)) {
        return { kind: 'help', error: 'unknown effort level' };
      }
      return { kind: 'model', target: tokens[1], model, effort };
    }
    case 'models':
      return extra(1) ?? { kind: 'models' };
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
      const target = tokens[1];
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
      if (tokens[1]?.toLowerCase() === 'models') return extra(2) ?? { kind: 'models' };
      return { kind: 'help' };
    default:
      return { kind: 'help', error: `unknown command \`${verb}\``, unknownVerb: true };
  }
}
