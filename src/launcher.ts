/**
 * Launcher — turns a spawn into a running interactive `claude` in a detached
 * tmux session owned by the agents user, wired to Zulip through the
 * mcpl-bridge plugin (dev channel) hosting zulip_mcp.
 *
 * Startup screens are handled from the pane (upstream's capture-pane /
 * send-keys handshake):
 *  - "Loading development channels" confirmation → Enter (upstream)
 *  - "Do you want to use this API key?" (ANTHROPIC_API_KEY in env) → the Yes option
 *  - first-run consents a PERSON must give once as the agents user (bypass
 *    permissions warning, folder trust) → abort with an operator instruction
 */
import type { SpawnerConfig } from './config.js';
import type { Tmux } from './tmux.js';

export interface LaunchRequest {
  personaName: string;
  model: string;
  /** Validated effort; absent ⇒ no flag (CLI default). */
  effort?: string;
  sessionId: string;
  /** --resume the existing transcript instead of starting fresh. */
  resume: boolean;
  tmuxSession: string;
  bridgeConfig: string;
  seedFile: string;
  /** Who spawned it (attribution header placeholder). */
  spawnedBy: string;
  streamName: string;
  topic: string;
}

export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The shell command tmux runs (via the agents user's shell -c). No secret is
 *  ever on it: the API key comes from the sourced env file. */
export function buildCommand(cfg: SpawnerConfig, req: LaunchRequest): string {
  // Every step is chained with && : a missing env file or seed must stop the
  // launch (bash, unlike POSIX sh, carries on after a failed `.`), never start
  // claude on inherited credentials or an empty prompt.
  const parts: string[] = [];
  if (cfg.agentsEnvFile) parts.push(`set -a && . ${shq(cfg.agentsEnvFile)} && set +a &&`);
  parts.push(`test -r ${shq(req.seedFile)} &&`);
  const env = ['exec', 'env'];
  // CLAUDE_CODE_EFFORT_LEVEL outranks --effort (upstream, claude 2.1.286).
  if (req.effort) env.push('-u', 'CLAUDE_CODE_EFFORT_LEVEL');
  env.push(`MCPL_BRIDGE_CONFIG=${shq(req.bridgeConfig)}`);
  const headers = renderHeaders(cfg.attributionHeaders, req);
  if (headers.length) env.push(`ANTHROPIC_CUSTOM_HEADERS="$(printf '%s\\n' ${headers.map(shq).join(' ')})"`);
  const claude = [
    shq(cfg.claudeBin),
    '--dangerously-skip-permissions',
    `--dangerously-load-development-channels ${shq(`plugin:${cfg.bridgePlugin}`)}`,
    // --resume reuses the id (no --fork-session): one hand, one transcript.
    req.resume ? `--resume ${shq(req.sessionId)}` : `--session-id ${shq(req.sessionId)}`,
    `--model ${shq(req.model)}`,
    // Effort is not restored by --resume, so it is passed on every launch.
    ...(req.effort ? [`--effort ${shq(req.effort)}`] : []),
    `"$(cat ${shq(req.seedFile)})"`,
  ];
  parts.push([...env, ...claude].join(' '));
  return parts.join(' ');
}

/** `Name: value` lines from the configured templates. */
export function renderHeaders(templates: Record<string, string>, req: Pick<LaunchRequest, 'personaName' | 'spawnedBy' | 'streamName' | 'topic'>): string[] {
  const vars: Record<string, string> = { hand: req.personaName, spawnedBy: req.spawnedBy, stream: req.streamName, topic: req.topic };
  return Object.entries(templates).map(([name, tpl]) => {
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error(`bad header name in attributionHeaders: ${JSON.stringify(name)}`);
    return `${name}: ${headerSafe(tpl.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m))}`;
  });
}

/** Header values: printable ASCII, no line breaks. */
export function headerSafe(v: string): string {
  return v.replace(/[^\x20-\x7e]/g, '?').slice(0, 120);
}

const DEV_CHANNELS_RE = /Loading development channels|local development/i;
const API_KEY_RE = /Do you want to use this API key\?/i;
const BYPASS_RE = /Bypass Permissions mode/i;
const TRUST_RE = /Do you trust the files in this folder|Is this a project you created or one you trust/i;
const READY_RE = /bypass permissions on|\? for shortcuts/i;
const OPTION_RE = /^\s*(?:❯\s*)?(\d+)\.\s+(.*\S)\s*$/;

export type StartupScreen = 'dev-channels' | 'api-key' | 'bypass-consent' | 'trust' | 'ready' | 'unknown';

export function classifyStartup(pane: string): StartupScreen {
  if (BYPASS_RE.test(pane) && /Yes, I accept/i.test(pane)) return 'bypass-consent';
  if (TRUST_RE.test(pane)) return 'trust';
  if (API_KEY_RE.test(pane)) return 'api-key';
  if (DEV_CHANNELS_RE.test(pane)) return 'dev-channels';
  if (READY_RE.test(pane)) return 'ready';
  return 'unknown';
}

/**
 * Keys that pick the option labelled "Yes…" on the dialog under `question`: its digit on a
 * numbered dialog, else arrows from the cursor (❯) to it, then Enter. Claude Code 2.1.312's
 * API-key dialog is the arrow kind:
 *     Do you want to use this API key?
 *       Yes
 *     ❯ No (recommended)
 *     Enter to confirm · Esc to cancel
 */
export function keysForYes(pane: string, question: RegExp): string[] | undefined {
  const digit = yesOption(pane);
  if (digit) return [digit];
  const lines = pane.split('\n');
  const start = lines.findIndex((l) => question.test(l));
  if (start < 0) return undefined;
  const items: { label: string; cursor: boolean }[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/Enter to confirm|Esc to cancel/i.test(line)) break;
    const m = line.match(/^\s*(❯\s*)?(\S.*?)\s*$/);
    if (m) items.push({ label: m[2], cursor: !!m[1] });
  }
  const cursor = items.findIndex((i) => i.cursor);
  const yes = items.findIndex((i) => /^yes\b/i.test(i.label));
  if (cursor < 0 || yes < 0) return undefined;
  const step = yes < cursor ? 'Up' : 'Down';
  return [...Array<string>(Math.abs(yes - cursor)).fill(step), 'Enter'];
}

/** The digit of the option labelled "Yes…" on a numbered dialog. */
export function yesOption(pane: string): string | undefined {
  for (const line of pane.split('\n')) {
    const m = line.match(OPTION_RE);
    if (m && /^yes\b/i.test(m[2])) return m[1];
  }
  return undefined;
}

const HANDSHAKE_TIMEOUT_MS = 90_000;
const HANDSHAKE_POLL_MS = 2_000;
const MAX_SENDS = 3;

export class ClaudeLauncher {
  constructor(
    private readonly cfg: SpawnerConfig,
    private readonly tmux: Tmux,
  ) {}

  /** Start the session and get it past its startup screens. Throws when it
   *  cannot start (the caller kills the session); returns a warning when it
   *  started but something needs a human look. */
  async launch(req: LaunchRequest): Promise<{ warning?: string }> {
    await this.tmux.newSession(req.tmuxSession, this.cfg.projectDir, buildCommand(this.cfg, req));
    return this.settleStartup(req.tmuxSession);
  }

  private async settleStartup(session: string): Promise<{ warning?: string }> {
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
    const sends: Record<string, number> = {};
    const press = async (screen: string, ...keys: string[]) => {
      sends[screen] = (sends[screen] ?? 0) + 1;
      if (sends[screen] > MAX_SENDS) {
        throw new Error(`the ${screen} screen did not go away after ${MAX_SENDS} attempts — attach as the agents user: tmux attach -t ${session}`);
      }
      await this.tmux.sendKeys(session, ...keys);
    };
    while (Date.now() < deadline) {
      if (!(await this.tmux.hasSession(session))) {
        throw new Error('claude exited during startup — check the env file and seed are readable by the agents user, the model name, the bridge plugin install and `claude` health');
      }
      const pane = await this.tmux.capturePane(session).catch(() => '');
      switch (classifyStartup(pane)) {
        case 'bypass-consent':
          throw new Error('Claude Code wants its one-time "Bypass Permissions mode" consent — a person must run `claude --dangerously-skip-permissions` once as the agents user and accept');
        case 'trust':
          throw new Error(`Claude Code asks whether to trust ${this.cfg.projectDir} — a person must run \`claude\` there once as the agents user and accept`);
        case 'api-key': {
          const keys = keysForYes(pane, API_KEY_RE);
          if (!keys) throw new Error('Claude Code asks whether to use the API key and I cannot find its Yes option — attach and answer it');
          await press('api-key', ...keys);
          break;
        }
        case 'dev-channels':
          await press('dev-channels', 'Enter');
          break;
        case 'ready':
          return {};
        default:
          break;
      }
      await sleep(HANDSHAKE_POLL_MS);
    }
    return { warning: `it did not reach its prompt within ${HANDSHAKE_TIMEOUT_MS / 1000}s — check with \`peek\`` };
  }
}
