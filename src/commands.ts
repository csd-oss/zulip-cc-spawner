/**
 * Command grammar and validation (ported from cc-spawner).
 *
 * Text grammar, over the message body with leading @-mentions stripped:
 *   spawn <model> [name=<friendly>] [effort=<level>]
 *   rename <hand> <new-friendly-name>
 *   model <hand> [<model>] [effort=<level>]
 *   models                (also: help models)
 *   list [stopped]
 *   delete <hand> [confirm]
 *   stop <name>            (alias: kill)
 *   peek <name> [lines] [here] (DM by default; here replies at invocation)
 *   answer <name> <choice>
 *   press <name> <keys…>
 *   rescan
 *   help
 */
export type Command =
  | { kind: 'spawn'; model: string; friendly?: string; effort?: string; engine?: 'claude' | 'codex' }
  | { kind: 'model'; target: string; model?: string; effort?: string }
  | { kind: 'rename'; target: string; friendly: string }
  | { kind: 'models' }
  | { kind: 'list'; stopped?: boolean; bySize?: boolean; creator?: 'mine' | 'unknown' | number }
  | { kind: 'delete'; target: string; confirm?: boolean; forceLegacy?: boolean; legacyToken?: string }
  | { kind: 'stop'; target: string }
  | { kind: 'peek'; target: string; lines?: number; here?: boolean }
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
  '`spawn <model> [name=<friendly-or-listed-target>] [effort=<level>] [engine=codex|claude]` — spawn a hand whose home is this stream + topic (model explicit: fable-5-2, opus-5-5, sonnet-5-5, haiku-4-5, … or a full id; Claude effort: low, medium, high, xhigh, max, ultracode — kept across revivals, `effort=default` clears it)',
  'Codex: `gpt-*` → `codex` CLI; other ids → `claude`. Override with `engine=codex|claude`. Display names: `[cx-<model>] <name>` (Claude: `[cc-<model>] <name>`); new bot emails/tmux/workdirs use only `cx-<name>` / `cc-<name>`.',
  `Codex efforts: ${[...new Set(MODEL_CAPABILITIES.filter((r) => r.engine === 'codex').flatMap((r) => r.efforts))].join(', ')} (passed through; model-dependent).`,
  '`model <hand> [<model>] [effort=...]` — live same-engine switch (follows creatorOnlyControls; open by default); omit model to list the live menu',
  '`rename <hand> <new-friendly-name>` — change the visible name only (follows creatorOnlyControls; open by default); old names remain aliases, including on revival',
  'Rename/model, model-menu answers and model-changing revival follow `creatorOnlyControls`: any allowed caller by default; creator/owner in strict mode (adopted hands with neither creator nor configured owner stay collaborative).',
  '`models` (or `help models`) — aliases, full ids, CLIs, allowed efforts and default behaviour',
  '`list` — show running hands',
  '`list stopped` — stopped hands with short name, creator, linked home and relative last activity',
  '`delete <hand> force-legacy` — configured admins only: preview legacy paths/bot IDs, then use the separate expiring confirmation token shown. No creation attestation is fabricated.',
  '`list stopped [mine|by=<user-id>|by=unknown] [by size]` — filter by recorded creator; show bounded apparent work-dir sizes in MB (GB at 1,000 MB), largest measured first with by size; partial/unknown sizes are labelled.',
  '`delete <hand> [confirm]` — creator/owner only, regardless of creatorOnlyControls; stopped hands only. Without confirm, preview registry entries, hand dir, workDir and bot deactivation; confirm permanently removes them (only proven spawner-created bots are deactivated). Replies here.',
  '`stop <name>` — stop a hand (identity and conversation are kept; `spawn` the same name revives it, optionally with a new home/model)',
  '`peek <name> [lines] [here]` — terminal tail (default 20 lines), DM by default; here shares it with everyone in the invoking topic (or replies in the invoking DM)',
  '`answer <name> <choice>` — answer a hand\'s pending question or permission prompt (`2`, `1,3`, `yes`/`no`, `text: …`, or `esc`)',
  '`press <name> <keys…>` — raw keystrokes into a hand\'s terminal (`press scout 1 enter`; keys: digits, `enter`, `esc`, `tab`, `up`/`down`, `ctrl-c`, or literal text)',
  '`rescan` — re-check every hand for an open question dialog and (re)post it',
].join('\n');

/**
 * Explicit model names → ids passed to `claude --model`. Bare family aliases
 * are refused: the CLI re-points them on upgrade; launches must be explicit.
 */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  'fable-5-2': 'claude-fable-5-2',
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
    'Other versioned short names of fable/opus/sonnet/haiku (`fable-5-3`, `opus6`, `opus-11`, `sonnet-10-1`) → `claude-<family>-X[-Y]`, parts as written; glued digit runs that are not a listed alias (`opus11`, `fable510`) are refused, never passed raw or guessed.',
    '`default` = CLI-selected effort (no override); clears stored effort on revival. Omitted effort inherits on revival. Model must be explicit; no default model.',
  ].join('\n');
}

const BARE_FAMILY_RE = /^(fable|opus|sonnet|haiku|best|opusplan)(\[1m\])?$/i;
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
/** A family name, an optional separator, then only version digits and `-`/`.` separators. */
const FAMILY_VERSION_ATTEMPT_RE = new RegExp(`^(${FAMILIES.join('|')})([-.]?)(\\d[\\d.-]*)$`);

/**
 * Parses a versioned family short name into `<family>-X[-Y]`, or explains why
 * it cannot. Nothing is guessed:
 * - version parts split by `-`/`.` are literal (`fable-5-10`, `fable5.2`,
 *   `opus10-2`); a lone run after a family separator is a literal major
 *   (`opus-11` → opus-11, `opus-10` → opus-10);
 * - a lone digit run is split into X-Y only when that spells a listed alias
 *   (`opus55`, `fable-52` → fable-5-2, `haiku45`);
 * - a single digit glued to the family is a literal major (`opus6`);
 * - any other glued run (`opus11`, `opus10`, `fable510`) is refused.
 * Returns undefined when `model` is not a family-version spelling at all.
 */
function parseFamilyVersion(model: string): { key: string } | { error: string } | undefined {
  const m = model.toLowerCase().match(FAMILY_VERSION_ATTEMPT_RE);
  if (!m) return undefined;
  const [, family, separator, rest] = m;
  const parts = rest.split(/[-.]/);
  const hint = `separate the version parts (\`${family}-X\`, \`${family}-X-Y\`) or give a full id like \`claude-${family}-X-Y\``;
  if (parts.length === 1) {
    const [run] = parts;
    const listed = run.length === 2 ? `${family}-${run[0]}-${run[1]}` : undefined;
    if (listed && listed in MODEL_ALIASES) return { key: listed };
    if (separator || run.length === 1) return { key: `${family}-${run}` };
    return { error: `ambiguous model version \`${model}\` — ${hint}` };
  }
  if (parts.length === 2 && parts.every((p) => /^\d+$/.test(p))) return { key: `${family}-${parts[0]}-${parts[1]}` };
  return { error: `unsupported model version \`${model}\` — ${hint}` };
}

/** Why a family-version spelling cannot be resolved, if it cannot. */
export function modelVersionError(model: string): string | undefined {
  const parsed = parseFamilyVersion(model);
  return parsed && 'error' in parsed ? parsed.error : undefined;
}

/**
 * Listed aliases first; any other versioned family short name (`fable-5-3`,
 * `opus6`, `sonnet-10-1`) maps generically to `claude-<family>-X[-Y]`. A family
 * short name is never passed raw: the CLI rejects it at the first message, not
 * at launch, so spawn refuses the ambiguous ones (`modelVersionError`) up front.
 * Also used on stored models: legacy entries may hold the raw short name.
 */
export function resolveModel(model: string): string {
  const parsed = parseFamilyVersion(model);
  if (!parsed || 'error' in parsed) return model;
  return MODEL_ALIASES[parsed.key] ?? `claude-${parsed.key}`;
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
  // Existing/listed targets may be longer than a new friendly name. Actions
  // enforce the 24-character limit only after resolving revival candidates.
  if (friendly !== undefined && !/^(?:[A-Za-z0-9-]+|hand:[A-Za-z0-9%_.~-]+)$/i.test(friendly)) {
    return { kind: 'help', error: `bad name \`${friendly}\` — use 1-24 chars of [A-Za-z0-9-], or a listed hand target` };
  }
  if (!model) return { kind: 'help', error: 'model is required — e.g. `spawn opus-5-5`, `spawn sonnet-5-5 name=scout`' };
  if (!MODEL_RE.test(model)) return { kind: 'help', error: `bad model \`${model}\`` };
  if (isBareFamilyAlias(model)) {
    return {
      kind: 'help',
      error: `bare \`${model}\` is refused — say which version: ${MODEL_CHOICES.map((c) => `\`${c}\``).join(', ')}, or a full id like \`claude-opus-5-5\``,
    };
  }
  const versionError = modelVersionError(model);
  if (versionError) return { kind: 'help', error: versionError };
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
  const tokens: string[] = body.match(/@_?\*\*[^*]+\*\*|\[[a-z0-9-]+(?:\/[a-z]+)?\]\s+[A-Za-z0-9-]+|\S+/gi) ?? [];
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
    case 'rename': {
      if (!tokens[1] || !tokens[2]) return { kind: 'help', error: 'rename needs a hand and a new name — `rename <hand> <new-friendly-name>`' };
      const trailing = extra(3);
      if (trailing) return trailing;
      if (!FRIENDLY_RE.test(tokens[2])) return { kind: 'help', error: `bad name \`${tokens[2]}\` — use 1-24 chars of [A-Za-z0-9-]` };
      return { kind: 'rename', target: tokens[1], friendly: tokens[2] };
    }
    case 'models':
      return extra(1) ?? { kind: 'models' };
    case 'list': {
      if (tokens[1]?.toLowerCase() !== 'stopped') return extra(1) ?? { kind: 'list' };
      const cmd: Extract<Command, { kind: 'list' }> = { kind: 'list', stopped: true };
      for (let i = 2; i < tokens.length; i++) {
        const token = tokens[i].toLowerCase();
        if (token === 'by' && tokens[i + 1]?.toLowerCase() === 'size' && !cmd.bySize) {
          cmd.bySize = true; i++;
        } else if (cmd.creator === undefined && (token === 'mine' || token === 'by=unknown' || /^by=[1-9][0-9]*$/.test(token))) {
          cmd.creator = token === 'mine' ? 'mine' : token === 'by=unknown' ? 'unknown' : Number(token.slice(3));
          if (typeof cmd.creator === 'number' && !Number.isSafeInteger(cmd.creator)) return { kind: 'help', error: 'Invalid creator user ID.' };
        } else return { kind: 'help', error: 'Use list stopped [mine|by=<user-id>|by=unknown] [by size].' };
      }
      return cmd;
    }
    case 'delete': {
      if (tokens[1] && tokens[2]?.toLowerCase() === 'force-legacy') {
        return extra(3) ?? { kind: 'delete', target: tokens[1], forceLegacy: true };
      }
      if (!tokens[1] || (tokens[2] && tokens[2].toLowerCase() !== 'confirm')) {
        return { kind: 'help', error: 'delete needs a hand and optional confirm — `delete <hand> [confirm]`' };
      }
      if (tokens[3]?.toLowerCase() === 'force-legacy') {
        const trailing = extra(5);
        if (trailing) return trailing;
        return { kind: 'delete', target: tokens[1], confirm: true, forceLegacy: true, legacyToken: tokens[4] };
      }
      const trailing = extra(3);
      if (trailing) return trailing;
      return tokens[2] ? { kind: 'delete', target: tokens[1], confirm: true } : { kind: 'delete', target: tokens[1] };
    }
    case 'stop':
    case 'kill':
      return extra(2) ?? buildStopCommand(tokens[1]);
    case 'peek': {
      const args = tokens.slice(2);
      const here = args.includes('here');
      const counts = args.filter(token => token !== 'here');
      if (args.filter(token => token === 'here').length > 1 || counts.length > 1) {
        return { kind: 'help', error: 'peek takes a target, optional line count, and optional here — `peek <name> [lines] [here]`' };
      }
      const command = buildPeekCommand(tokens[1], counts[0]);
      return here && command.kind === 'peek' ? { ...command, here: true } : command;
    }
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
