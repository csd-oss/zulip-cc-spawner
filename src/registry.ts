/**
 * Persistent registry of spawned hands — ~/.cc-spawner/registry.json.
 * Atomic writes (tmp + rename). Stopped entries are kept as history; reviving
 * a name adds a fresh entry (the same Zulip bot makes it the same identity).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
  /** The hand's Zulip bot. Its API key is never stored here (owner can read it
   *  back). 0/'' while provisioning has not created or found it yet. */
  botUserId: number;
  botEmail: string;
  tmuxSession: string;
  /** Home: the stream + topic it was spawned in. Stream id survives renames. */
  streamName: string;
  streamId: number;
  topic: string;
  /** Per-hand files: zuliprc, bridge config, seed, zulip_mcp state. */
  handDir: string;
  model: string;
  /** Reasoning effort this launch ran with; re-passed on revival (CC does not restore it). */
  effort?: string;
  /** Claude Code conversation id — assigned at first launch, --resume'd on revival. */
  sessionId: string;
  spawnedBy: { userId: number; username: string };
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
    const t = target.toLowerCase().replace(/^@\*\*|\*\*$/g, '');
    return this.alive().find(
      (e) =>
        e.suffix.toLowerCase() === t ||
        e.personaName.toLowerCase() === t ||
        e.botEmail.toLowerCase() === t ||
        e.tmuxSession.toLowerCase() === t,
    );
  }

  byBotUserId(userId: number): BotEntry | undefined {
    return this.alive().find((e) => e.botUserId === userId);
  }

  /**
   * Most recent entry for a persona that got as far as having a bot — the
   * revival source. Failed launches count: a launch that failed after claude
   * started may already have written its transcript, and resuming it keeps
   * continuity (the caller checks the transcript exists).
   */
  latestFor(personaName: string): BotEntry | undefined {
    const name = personaName.toLowerCase();
    return [...this.entries]
      .reverse()
      .find((e) => e.personaName.toLowerCase() === name && e.status !== 'provisioning' && e.botUserId > 0);
  }

  /** The entry that owns a hand name right now (alive, mid-spawn or awaiting cleanup). */
  busy(suffix: string): BotEntry | undefined {
    const s = suffix.toLowerCase();
    return this.occupied().find((e) => e.suffix.toLowerCase() === s);
  }

  add(entry: BotEntry): void {
    this.entries.push(entry);
    this.save();
  }

  update(entry: BotEntry, patch: Partial<BotEntry>): void {
    Object.assign(entry, patch);
    this.save();
  }
}
