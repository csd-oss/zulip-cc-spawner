import type { BotEntry, Registry } from './registry.js';
import type { ZulipMessage } from './zulip.js';
import type { Notifier } from './notifier.js';
import { QUEUE_FAILURE } from './codex.js';

/** Flags must be fetched as the HAND: spawner flags describe the spawner. */
export function addressed(e: BotEntry, m: ZulipMessage): boolean {
  return e.engine === 'codex' && e.status === 'alive' && m.type === 'stream' &&
    m.stream_id === e.streamId && m.subject.toLowerCase() === e.topic.toLowerCase() &&
    m.sender_id !== e.botUserId && Boolean(m.flags?.includes('mentioned'));
}

const MAX_PENDING = 20;
const NOTICE_INTERVAL_MS = 60_000;

export class CodexWake {
  private startup = new Map<BotEntry, { promise: Promise<void>; resolve: () => void }>();

  /** Release startup intake only after the session id and boundary are durable. */
  ready(e: BotEntry): void {
    this.startup.get(e)?.resolve();
    this.startup.delete(e);
  }

  private candidates = new Map<BotEntry, number[]>();
  private checks = new Map<BotEntry, Promise<void>>();
  private pending = new Map<BotEntry, number>();
  private tails = new Map<BotEntry, Promise<void>>();
  private lastNotice = new WeakMap<BotEntry, number>();
  private notifying = new WeakSet<BotEntry>();
  constructor(private registry: Registry, private notifier: Notifier,
    private asHand: (e: BotEntry, id: number) => Promise<ZulipMessage | undefined>,
    private queue: (e: BotEntry, text: string) => Promise<void>,
    private delay = () => new Promise<void>((r) => setTimeout(r, 1000)),
    private now = Date.now) {}

  onMessage(m: ZulipMessage): void {
    for (const e of [...this.registry.alive(), ...(this.registry.provisioning?.() ?? [])]) {
      if (e.engine !== 'codex' || m.type !== 'stream' || m.stream_id !== e.streamId ||
          m.subject.toLowerCase() !== e.topic.toLowerCase() || m.sender_id === e.botUserId) continue;
      if (e.status === 'provisioning' && !this.startup.has(e)) {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => { resolve = r; });
        this.startup.set(e, { promise, resolve });
      }
      let candidates = this.candidates.get(e);
      if (!candidates) {
        candidates = [];
        this.candidates.set(e, candidates);
      }
      // Retain the newest candidates, so a burst of ambient messages cannot
      // reserve all intake slots against the next mention. Addressing is still
      // unknown here: overload and lookup failures must never post to chat.
      if (candidates.length >= MAX_PENDING) {
        candidates.shift();
        console.warn('[codex wake] addressing intake full; dropped oldest candidate');
      }
      candidates.push(m.id);
      if (!this.checks.has(e)) {
        const check = Promise.resolve().then(async () => {
          try {
            await this.startup.get(e)?.promise;
            while (candidates.length && e.status === 'alive') {
              const id = candidates.shift()!;
              if (id <= (e.codexCatchupThrough ?? 0)) continue;
              try {
                const own = await this.asHand(e, id);
                if (own && addressed(e, own)) await this.admit(e, own);
              } catch (err) {
                console.error('[codex wake] addressing lookup failed', err);
              }
            }
          } finally {
            this.candidates.delete(e);
            this.checks.delete(e);
          }
        });
        this.checks.set(e, check);
      }
    }
  }

  /** Only confirmed addressed messages may consume wake slots or post errors. */
  private async admit(e: BotEntry, own: ZulipMessage): Promise<void> {
    if ((this.pending.get(e) ?? 0) >= MAX_PENDING) {
      await this.notice(e);
      return;
    }
    this.pending.set(e, (this.pending.get(e) ?? 0) + 1);
    const next = (this.tails.get(e) ?? Promise.resolve()).then(async () => {
      if (e.status !== 'alive') return;
      if (!e.sessionId) throw new Error('missing Codex session id');
      await this.queue(e, `From ${own.sender_full_name} in #${e.streamName} > ${own.subject}:\n${own.content}`);
      await this.delay();
    }).catch(async (err) => {
      console.error('[codex wake]', err);
      await this.notice(e);
      await this.delay();
    }).finally(() => {
      this.pending.set(e, (this.pending.get(e) ?? 1) - 1);
      if (this.tails.get(e) === next) { this.tails.delete(e); this.pending.delete(e); }
    });
    this.tails.set(e, next);
  }

  private async notice(e: BotEntry): Promise<void> {
    const now = this.now();
    const last = this.lastNotice.get(e);
    if (this.notifying.has(e) || (last !== undefined && now - last < NOTICE_INTERVAL_MS)) return;
    this.lastNotice.set(e, now);
    this.notifying.add(e);
    try { await this.notifier.postHome(e, QUEUE_FAILURE); }
    catch (err) { console.error('[codex wake] notice failed', err); }
    finally { this.notifying.delete(e); }
  }

  async drain(): Promise<void> {
    // Checks can add wake tasks; wait for both stages, including work admitted
    // while an earlier drain snapshot was pending.
    while (this.checks.size || this.tails.size) {
      await Promise.all([...this.checks.values(), ...this.tails.values()]);
    }
  }
}
