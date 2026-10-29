/**
 * Reaper (ported from cc-spawner) — periodic sweep over alive hands plus the
 * startup reconcile.
 *
 * Activity = PUBLIC Zulip traffic only (the hand's posts/reactions). Internal
 * work does not count: a hand that never posts for `inactivityMs` is reaped
 * even if busy. Before reaping, Zulip itself is asked for the hand's newest
 * message, so an outage of the spawner's event queue never reaps an active
 * hand. Reaping keeps the identity: the bot, its files and its transcript stay.
 *
 * Also warns once when a hand has said nothing at all since launch — the sign
 * of a hand that never connected to Zulip.
 */
import type { SpawnerConfig } from './config.js';
import type { Notifier } from './notifier.js';
import type { BotEntry, Registry } from './registry.js';
import type { Tmux } from './tmux.js';

const log = (msg: string) => console.log(`${new Date().toISOString()} [reaper] ${msg}`);

/** Epoch ms of the newest message a hand's bot sent, anywhere, or undefined. */
export type LastPostLookup = (entry: Pick<BotEntry, 'botUserId' | 'botEmail'>) => Promise<number | undefined>;

export const SILENCE_WARN_MS = 10 * 60_000;

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round((minutes / 60) * 10) / 10}h`;
}

export class Reaper {
  constructor(
    private readonly registry: Registry,
    private readonly tmux: Tmux,
    private readonly notifier: Notifier,
    private readonly config: Pick<SpawnerConfig, 'inactivityMs'>,
    private readonly lastPost: LastPostLookup,
  ) {}

  /** Startup: align the registry with tmux. Silent (no Zulip spam). */
  async reconcile(): Promise<void> {
    for (const entry of this.registry.provisioning()) {
      // The daemon died mid-spawn. Whatever got started is not tracked: stop it.
      log(`reconcile: ${entry.personaName} was mid-spawn — stopping whatever started`);
      this.registry.update(entry, { status: 'cleanup', endReason: 'interrupted during spawn (spawner restarted)' });
      await this.retryCleanup(entry);
    }
    for (const entry of this.registry.alive()) {
      if (!(await this.tmux.hasSession(entry.tmuxSession))) {
        log(`reconcile: ${entry.personaName} tmux session gone — marking died`);
        this.registry.update(entry, { status: 'reaped', endReason: 'died' });
      }
    }
    const known = new Set(this.registry.alive().map((e) => e.tmuxSession));
    for (const session of await this.tmux.listSessions()) {
      if (session.startsWith('cc-') && !known.has(session)) {
        log(`reconcile: unknown tmux session ${session} (cc- prefix, not in registry) — leaving it alone`);
      }
    }
  }

  /** Kill a cleanup-pending session; only a confirmed kill frees the name. */
  private async retryCleanup(entry: BotEntry): Promise<void> {
    try {
      await this.tmux.killSession(entry.tmuxSession);
      this.registry.update(entry, { status: 'failed' });
    } catch (err) {
      log(`cleanup of ${entry.tmuxSession} still failing: ${(err as Error).message}`);
    }
  }

  async sweep(): Promise<void> {
    for (const entry of this.registry.cleanup()) await this.retryCleanup(entry);
    for (const entry of this.registry.alive()) {
      try {
        await this.check(entry);
      } catch (err) {
        // tmux/sudo trouble is not evidence the hand is gone — skip this round.
        log(`sweep error for ${entry.personaName}: ${(err as Error).message}`);
      }
    }
  }

  private async check(entry: BotEntry): Promise<void> {
    if (!(await this.tmux.hasSession(entry.tmuxSession))) {
      log(`${entry.personaName}: session died`);
      this.registry.update(entry, { status: 'reaped', endReason: 'died' });
      await this.notifier.postHome(entry, `${entry.personaName} exited on its own (tmux session gone). \`spawn ${entry.model} name=${entry.suffix}\` revives the same identity and conversation.`);
      return;
    }

    const sinceSpawn = Date.now() - Date.parse(entry.spawnedAt);
    if (!entry.firstPostAt && !entry.silenceWarned && sinceSpawn > SILENCE_WARN_MS) {
      const posted = await this.lastPost(entry).catch(() => undefined);
      if (posted !== undefined && posted >= Date.parse(entry.spawnedAt)) {
        this.registry.update(entry, { firstPostAt: new Date(posted).toISOString() });
      } else {
        this.registry.update(entry, { silenceWarned: true });
        await this.notifier.postHome(entry, `⚠️ **${entry.personaName}** has not posted anything in ${formatDuration(sinceSpawn)} since it started — it may not be connected to Zulip. \`peek ${entry.suffix}\` shows its terminal.`);
      }
    }

    let last = Date.parse(entry.lastActivity) || 0;
    if (Date.now() - last <= this.config.inactivityMs) return;
    // Our own view says idle; ask Zulip before acting on it.
    const posted = await this.lastPost(entry);
    if (posted !== undefined && posted > last) {
      last = posted;
      this.registry.update(entry, { lastActivity: new Date(posted).toISOString() });
      if (Date.now() - last <= this.config.inactivityMs) return;
    }

    const idle = formatDuration(Date.now() - last);
    log(`${entry.personaName}: idle ${idle} — reaping`);
    await this.notifier.postHome(entry, `Reaping ${entry.personaName} — no public activity for ~${idle}. Its identity and conversation are kept; \`spawn ${entry.model} name=${entry.suffix}\` revives it.`);
    await this.tmux.killSession(entry.tmuxSession);
    this.registry.update(entry, { status: 'reaped', endReason: 'reaped-idle' });
  }
}
