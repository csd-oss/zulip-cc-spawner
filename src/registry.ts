import { type DirectoryIdentity } from './directory-owner.js';
/**
 * Persistent registry of spawned hands — ~/.cc-spawner/registry.json.
 * Atomic writes (tmp + rename). Stopped entries are kept as history; reviving
 * a name adds a fresh entry (the same Zulip bot makes it the same identity).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalHandTarget, handIdentityName, isHandTarget } from './names.js';
import { botEmailPrefix } from './provision.js';
import type { PendingQuestion } from './question.js';

/**
 * provisioning: written BEFORE any side effect (bot, files, tmux) so a crash or
 * failure mid-spawn leaves a record of what may exist; startup reconciles it.
 * cleanup: a failed spawn whose tmux session could not be confirmed killed —
 * still occupies its name and a capacity slot; the reaper retries the kill.
 * failed: a spawn that did not complete and left nothing running (the bot is kept).
 */
export type BotStatus = 'provisioning' | 'alive' | 'reaped' | 'cleanup' | 'failed';

export interface BotEntry {
  /** Name suffix — 4 random hex or the operator-chosen friendly name. */
  suffix: string;
  /** The hand's Zulip full name, e.g. Claude-Code-opus-5-5-scout. */
  personaName: string;
  /** Set only by explicit rename; suffix and all session identifiers stay fixed. */
  friendlyName?: string;
  /** Previous friendly/full names, reserved to this tmux identity across launches. */
  nameAliases?: string[];
  /** The hand's Zulip bot. Its API key is never stored here (owner can read it
   *  back). 0/'' while provisioning has not created or found it yet. */
  botUserId: number;
  botEmail: string;
  /** Positive provenance only; absent on old/adopted records. Never infer ownership. */
  botCreatedBySpawner?: boolean;
  tmuxSession: string;
  /** Home: the stream + topic it was spawned in. Stream id survives renames. */
  streamName: string;
  streamId: number;
  topic: string;
  /** Per-hand files: zuliprc, bridge config, seed, zulip_mcp state. */
  handDir: string;
  /** True only after writing files into a directory exclusively created by us. */
  handDirReady?: boolean;
  /** Exclusive-creation identity; absent on all pre-attestation records. */
  handDirIdentity?: DirectoryIdentity;
  /** Absent on legacy hands: retain config.projectDir. */
  workDir?: string;
  /** Set only after exclusive workspace creation and trust preparation succeed. */
  workDirReady?: boolean;
  workDirIdentity?: DirectoryIdentity;
  /** Pre-attestation workspace adopted at revival: {dev, ino, nonce} of the
   *  marker written then. Proves continuity for later revivals only, never
   *  creation: delete (ordinary and force-legacy) treats the hand as legacy. */
  workDirAdoption?: DirectoryIdentity;
  nameScheme?: 'bracket-v1' | 'stable-v2';
  harness?: string;
  engine?: 'claude' | 'codex';
  model: string;
  /** Reasoning effort this launch ran with; re-passed on revival (CC does not restore it). */
  effort?: string;
  /** Claude Code conversation id — assigned at first launch, --resume'd on revival. */
  sessionId: string;
  /** Inclusive model-owned backscroll boundary; wake owns only newer ids. */
  codexCatchupThrough?: number;
  /** Unknown for some historical hands; revival must never assign a creator. */
  spawnedBy?: { userId: number; username: string };
  spawnedAt: string;
  /** Last PUBLIC Zulip activity (message/reaction) the spawner observed. */
  lastActivity: string;
  /** First message the hand posted after this launch — proof it hears Zulip. */
  firstPostAt?: string;
  /** The "hasn't said anything since spawn" warning was posted. */
  silenceWarned?: boolean;
  status: BotStatus;
  /** Why the entry left 'alive' (reaped-idle | died | stopped by …). */
  endReason?: string;
  seedFile: string;
  /** How far into the transcript JSONL the watcher has read. */
  transcriptOffset?: number;
  /** Last assistant model seen in the transcript (fallback detection). */
  lastModel?: string;
  /** A dialog the session is blocked on (posted to the home topic). */
  pendingQuestion?: PendingQuestion;
  /** Snapshot only: no TUI is left open while waiting for a Zulip answer. */
  pendingModelMenu?: {
    options: { number: number; label: string; model: string }[];
    effort?: string;
    postedAt: string;
  };
}

export class Registry {
  private entries: BotEntry[] = [];

  constructor(private readonly path: string) {}

  load(): void {
    if (existsSync(this.path)) this.entries = JSON.parse(readFileSync(this.path, 'utf8')) as BotEntry[];
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  all(): readonly BotEntry[] {
    return this.entries;
  }

  alive(): BotEntry[] {
    return this.entries.filter((e) => e.status === 'alive');
  }

  provisioning(): BotEntry[] {
    return this.entries.filter((e) => e.status === 'provisioning');
  }

  cleanup(): BotEntry[] {
    return this.entries.filter((e) => e.status === 'cleanup');
  }

  /** Hands that occupy a slot: alive, mid-spawn, or awaiting cleanup. */
  occupied(): BotEntry[] {
    return this.entries.filter((e) => e.status === 'alive' || e.status === 'provisioning' || e.status === 'cleanup');
  }

  /** An ALIVE entry by suffix, persona name, bot email or tmux session. */
  findAlive(target: string): BotEntry | undefined {
    const matches = this.matchingHands(target);
    return matches.length === 1 && matches[0].status === 'alive' ? matches[0] : undefined;
  }

  private matches(e: BotEntry, target: string): boolean {
    // Keep 0e768759 command mention handling: no silent mentions or ID stripping.
    // In particular a name carrying another bot's ID must never select this bot.
    const mentionedId = target.match(/\|(\d+)/)?.[1];
    if (mentionedId !== undefined && Number(mentionedId) !== e.botUserId) return false;
    const t = handIdentityName(target.toLowerCase().replace(/^@\*\*|\*\*$/g, ''));
    return [e.suffix, e.personaName, e.botEmail, e.tmuxSession, e.friendlyName, ...(e.nameAliases ?? [])]
      .some((name) => name !== undefined && handIdentityName(name) === t);
  }

  /** Latest launch per stable identity, without mutating historical records. */
  currentHands(): BotEntry[] {
    return [...new Map(this.entries.map((e) => [e.tmuxSession, e])).values()];
  }

  matchingHands(target: string): BotEntry[] {
    // Reserved namespace bypasses aliases, even in imported colliding registries.
    // The prefix is reserved in every case (`HAND:`, `Hand:`), so an imported
    // alias spelled like a reserved target is never matched as an alias.
    if (isHandTarget(target)) {
      try {
        const session = decodeURIComponent(target.slice('hand:'.length));
        return this.currentHands().filter(e => e.tmuxSession === session);
      } catch { return []; }
    }
    return this.currentHands().filter((e) => this.matches(e, target));
  }

  /** Copyable by both target commands and spawn name=; never an ambiguous alias. */
  commandTarget(entry: BotEntry): string {
    for (const candidate of [entry.friendlyName ?? entry.suffix, entry.tmuxSession]) {
      if (!/^[A-Za-z0-9-]+$/.test(candidate)) continue;
      const matches = this.matchingHands(candidate);
      if (matches.length === 1 && matches[0].tmuxSession === entry.tmuxSession) return candidate;
    }
    return canonicalHandTarget(entry);
  }

  /** Spawn fallback only: never treat a stable suffix/session/email as a rename. */
  renamedHands(target: string): BotEntry[] {
    const t = handIdentityName(target);
    return this.currentHands().filter((e) => [e.friendlyName, ...(e.nameAliases ?? [])]
      .some((name) => name !== undefined && handIdentityName(name) === t));
  }

  /** All historical names remain reserved, including stopped/failed hands. */
  nameCollision(result: BotEntry, reserveNewBotEmail = false): boolean {
    const names = (e: BotEntry): string[] => [
      e.suffix, e.tmuxSession, e.personaName, e.botEmail, e.friendlyName,
      e.personaName.match(/^\[[^\]]+\] (.+)$/)?.[1], ...(e.nameAliases ?? []),
    ].filter((name): name is string => name !== undefined && name !== '').map(handIdentityName);
    const resultingNames = new Set(names(result));
    // Before provisioning, the full email's realm suffix is not known. Reserve
    // its Zulip-generated prefix too, across every historical name/alias.
    const prefix = reserveNewBotEmail ? botEmailPrefix(result.tmuxSession) : undefined;
    return this.entries.some(e => e.tmuxSession !== result.tmuxSession &&
      names(e).some(name => resultingNames.has(name) || prefix !== undefined && name.startsWith(prefix)));
  }

  /** Current launch, including activity during startup; never stopped history. */
  byBotUserId(userId: number): BotEntry | undefined {
    return this.entries.find((e) => (e.status === 'alive' || e.status === 'provisioning') && e.botUserId === userId);
  }

  /**
   * Most recent entry for a persona that got as far as having a bot — the
   * revival source. Failed launches count: a launch that failed after claude
   * started may already have written its transcript, and resuming it keeps
   * continuity (the caller checks the transcript exists).
   */
  latestFor(personaName: string): BotEntry | undefined {
    const name = handIdentityName(personaName);
    return [...this.entries]
      .reverse()
      .find((e) => handIdentityName(e.personaName) === name && e.status !== 'provisioning' && e.botUserId > 0);
  }

  /** The entry that owns a hand name right now (alive, mid-spawn or awaiting cleanup). */
  busy(suffix: string, selectedSession?: string): BotEntry | undefined {
    const s = suffix.toLowerCase();
    // Preserve the legacy suffix guard, but a rename alias may only occupy the
    // selected identity. Session/email matches must not steal a spawn name.
    return this.occupied().find((e) => e.suffix.toLowerCase() === s ||
      (selectedSession === undefined || e.tmuxSession === selectedSession) &&
      [e.friendlyName, ...(e.nameAliases ?? [])].some((name) => name !== undefined && handIdentityName(name) === handIdentityName(s)));
  }

  add(entry: BotEntry): void {
    this.entries.push(entry);
    this.save();
  }

  /** Remove every launch for one stable hand, using the usual atomic save. */
  removeHand(tmuxSession: string): number {
    const previous = this.entries;
    this.entries = previous.filter(e => e.tmuxSession !== tmuxSession);
    try { this.save(); }
    catch (err) { this.entries = previous; throw err; }
    return previous.length - this.entries.length;
  }

  update(entry: BotEntry, patch: Partial<BotEntry>): void {
    Object.assign(entry, patch);
    this.save();
  }
}
