/**
 * Spawner configuration — ~/.cc-spawner/config.json (or $CC_SPAWNER_CONFIG)
 * plus env overrides for the timing knobs.
 *
 * Fail-closed by design: empty `allowedStreams` means the spawner answers
 * nowhere (`["*"]`: every stream the spawner bot is subscribed to); empty
 * `allowedUsers` + `allowedGroups` means nobody may drive it.
 * A template is written on first run so the operator has something concrete
 * to fill in. Secrets never live here: the two zuliprc files are referenced
 * by path.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface SpawnerConfig {
  /** zuliprc of the spawner's own bot — listens for commands, posts replies. */
  spawnerRc: string;
  /** zuliprc of the HUMAN account that owns the hands' bots (creates them,
   *  reads their keys back, subscribes them to streams). Bots cannot do this. */
  adminRc: string;
  /**
   * Streams the spawner answers in (names, case-insensitive). Checked before
   * every other auth leg; the spawner must also be subscribed to them, since
   * Zulip delivers stream messages to subscribers only. Empty ⇒ deny everywhere.
   */
  allowedStreams: string[];
  /** Zulip user ids allowed unconditionally. */
  allowedUsers: number[];
  /** Zulip user-group ids whose members may drive the spawner (system groups
   *  like role:administrators work too; membership is checked recursively). */
  allowedGroups: number[];
  /** Bot user ids of RESIDENT agents allowed to summon/dismiss their own hands.
   *  Hands this spawner created are always refused (no recursion). */
  allowedResidents: number[];
  /** Max concurrently alive hands. */
  maxSessions: number;
  /** Reap a hand after this long without PUBLIC Zulip activity (default 24h). */
  inactivityMs: number;
  /** Reaper sweep interval (default 10 min). */
  reapIntervalMs: number;
  /** Transcript/dialog watch interval (default 20s). */
  watchIntervalMs: number;
  /** cwd for every hand — shared, like upstream (project auto-memory applies). */
  projectDir: string;
  /** OS user the hands run as (via `sudo -n -u`). Required unless `devMode`. */
  agentsUser?: string;
  /** Run hands as the spawner's own user (dev machine only: hands can then
   *  read the operator's zuliprc). Must be set explicitly. */
  devMode: boolean;
  /** tmux socket of the agents' tmux server. On the box that server runs as its
   *  own systemd unit (cc-agents-tmux.service) so stopping the spawner never
   *  kills hands. Unset ⇒ tmux's default socket for the agents user. */
  tmuxSocket?: string;
  /** Home of that user: Claude Code transcripts live under <home>/.claude. */
  agentsHome: string;
  /** Per-hand files (zuliprc, bridge config, seed, zulip_mcp state), one
   *  directory per hand, owned by the agents user. */
  handsDir: string;
  /** Env file sourced into every hand (e.g. model endpoint + API key), rendered by your secret manager.
   *  Unset ⇒ the hand inherits only what the agents user's tmux server has. */
  agentsEnvFile?: string;
  /** Claude Code CLI, absolute path as the agents user sees it. */
  claudeBin: string;
  /** node binary that runs zulip_mcp under the bridge. */
  nodeBin: string;
  /** zulip_mcp entry point (build/index.js). */
  zulipMcp: string;
  /** Claude Code plugin id of the MCPL bridge (dev-channel flag target). */
  bridgePlugin: string;
  /**
   * Extra HTTP headers every hand sends with its model requests
   * (ANTHROPIC_CUSTOM_HEADERS) — e.g. per-hand attribution for an inference
   * gateway's ledger. Values may use {hand}, {spawnedBy}, {stream}, {topic}.
   * Empty ⇒ none. Header names and values must be printable ASCII.
   */
  attributionHeaders: Record<string, string>;
  /** DM gate for hands (bridge `dmAllowlist`): channel or author ids whose DMs
   *  reach a hand. [] ⇒ no DMs (fail closed). */
  handDmAllowlist: string[];
  /** zulip_mcp per-channel catch-up ceiling for hands. */
  catchupLimit: number;
}

const HOME = homedir();
export const STATE_DIR = process.env.CC_SPAWNER_STATE_DIR ?? join(HOME, '.cc-spawner');
export const REGISTRY_PATH = join(STATE_DIR, 'registry.json');
export const STATE_PATH = join(STATE_DIR, 'state.json');

const DEFAULTS: SpawnerConfig = {
  spawnerRc: join(STATE_DIR, 'spawner.zuliprc'),
  adminRc: join(STATE_DIR, 'admin.zuliprc'),
  allowedStreams: [],
  allowedUsers: [],
  allowedGroups: [],
  allowedResidents: [],
  devMode: false,
  maxSessions: 10,
  inactivityMs: 24 * 60 * 60 * 1000,
  reapIntervalMs: 10 * 60 * 1000,
  watchIntervalMs: 20 * 1000,
  projectDir: join(HOME, 'workspace'),
  agentsHome: HOME,
  handsDir: join(HOME, '.cc-hands'),
  claudeBin: join(HOME, '.local/bin/claude'),
  nodeBin: 'node',
  zulipMcp: join(HOME, 'zulip_mcp/build/index.js'),
  bridgePlugin: 'mcpl-bridge@mcpl-bridge-dev',
  attributionHeaders: {},
  handDmAllowlist: [],
  catchupLimit: 500,
};

export function configPath(): string {
  return process.env.CC_SPAWNER_CONFIG ?? join(STATE_DIR, 'config.json');
}

export function loadConfig(): SpawnerConfig {
  const path = configPath();
  let fileCfg: Partial<SpawnerConfig> = {};
  if (existsSync(path)) {
    fileCfg = JSON.parse(readFileSync(path, 'utf8')) as Partial<SpawnerConfig>;
  } else {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(DEFAULTS, null, 2) + '\n', { mode: 0o600 });
    console.warn(`[config] wrote template config to ${path} — fill in allowedStreams and allowedUsers/allowedGroups (currently deny-all)`);
  }
  const cfg: SpawnerConfig = { ...DEFAULTS, ...fileCfg };

  const envNum = (name: string, current: number): number => {
    const raw = process.env[name];
    if (!raw) return current;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`bad ${name}: ${raw}`);
    return n;
  };
  cfg.inactivityMs = envNum('CC_SPAWNER_INACTIVITY_MS', cfg.inactivityMs);
  cfg.reapIntervalMs = envNum('CC_SPAWNER_REAP_INTERVAL_MS', cfg.reapIntervalMs);
  cfg.watchIntervalMs = envNum('CC_SPAWNER_WATCH_INTERVAL_MS', cfg.watchIntervalMs);

  for (const [key, file] of [['spawnerRc', cfg.spawnerRc], ['adminRc', cfg.adminRc]] as const) {
    if (!existsSync(file)) throw new Error(`${key}: no zuliprc at ${file}`);
  }
  if (cfg.allowedStreams.length === 0) {
    console.warn('[config] allowedStreams is empty — every command will be denied until it is populated');
  }
  if (cfg.allowedUsers.length === 0 && cfg.allowedGroups.length === 0) {
    console.warn('[config] allowedUsers and allowedGroups are empty — every command will be denied until one is populated');
  }
  if (!cfg.agentsUser && !cfg.devMode) {
    throw new Error('agentsUser is unset — set it (hands run as that OS user), or set "devMode": true to run hands as this user on a dev machine');
  }
  if (cfg.agentsUser && cfg.devMode) throw new Error('set either agentsUser or devMode, not both');
  return cfg;
}
