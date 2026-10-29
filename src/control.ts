/**
 * Zulip control surface — the spawner bot's event queue.
 *
 * What counts as a command:
 *  - a stream message that STARTS with the spawner's own @-mention (flag
 *    `mentioned` alone is not enough: "… stop scout … @spawner" mid-sentence,
 *    or a quoted mention, must not run anything);
 *  - any DM to the spawner.
 * Zulip delivers stream messages to subscribers only, so the spawner hears
 * streams it is subscribed to; auth additionally requires allowedStreams
 * (`"*"` = all of those).
 *
 * Offline commands are never executed (upstream semantics). The queue is
 * registered FIRST; its max_message_id bounds the backlog, which is paged back
 * to the persisted cursor and answered with at most one notice per topic/DM.
 * A queue that expires mid-run (BAD_EVENT_QUEUE_ID) is handled the same way.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ActionResult, SpawnerActions } from './actions.js';
import type { Invoker, Where } from './auth.js';
import { streamAllowed } from './auth.js';
import { parseCommand, stripMentions } from './commands.js';
import type { SpawnerConfig } from './config.js';
import type { Notifier } from './notifier.js';
import { ZulipApiError, type ZulipClient, type ZulipEvent, type ZulipMessage } from './zulip.js';

const log = (msg: string) => console.log(`${new Date().toISOString()} [control] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Persisted cursor: the newest message id the spawner has accounted for. */
export class ControlState {
  lastSeenMessageId?: number;

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { lastSeenMessageId?: number };
      this.lastSeenMessageId = raw.lastSeenMessageId;
    }
  }

  advance(id: number): void {
    if (this.lastSeenMessageId !== undefined && id <= this.lastSeenMessageId) return;
    this.lastSeenMessageId = id;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ lastSeenMessageId: id }) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does the raw markdown start — at its very first character — with a
 *  (non-silent) mention of this user? No leading whitespace: indented text is
 *  a code block in Zulip markdown, and code must never run as a command. */
export function startsWithMention(content: string, fullName: string, userId: number): boolean {
  const re = new RegExp(`^@\\*\\*${escapeRe(fullName)}(\\|${userId})?\\*\\*`, 'i');
  const reById = new RegExp(`^@\\*\\*[^*|]*\\|${userId}\\*\\*`);
  return re.test(content) || reById.test(content);
}

const MAX_STALE_NOTICES = 10;
const PAGE = 100;

export class ZulipControl {
  private me!: { user_id: number; full_name: string };
  private queueId?: string;
  private lastEventId = -1;
  private stopped = false;
  /** Command intake runs strictly in arrival order (user lookups included),
   *  so "spawn" then "stop" can never execute as "stop" then "spawn". */
  private intake: Promise<void> = Promise.resolve();
  private readonly users = new Map<number, { isBot: boolean; name: string }>();

  constructor(
    private readonly client: ZulipClient,
    private readonly actions: SpawnerActions,
    private readonly notifier: Notifier,
    private readonly config: SpawnerConfig,
    private readonly state: ControlState,
  ) {}

  get name(): string {
    return this.me?.full_name ?? 'spawner';
  }

  async start(): Promise<void> {
    const me = await this.client.me();
    if (!me.is_bot) log(`warning: the spawner runs as a HUMAN account (${me.email}) — it should be a bot`);
    this.me = { user_id: me.user_id, full_name: me.full_name };
    log(`listening as ${me.full_name} (${me.user_id})`);
    await this.register();
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async register(): Promise<void> {
    const r = await this.client.register(['message', 'reaction']);
    this.queueId = r.queue_id;
    this.lastEventId = r.last_event_id;
    const bound = r.max_message_id ?? 0;
    const since = this.state.lastSeenMessageId;
    if (since !== undefined && bound > since) {
      await this.answerStale(since, bound).catch((err) => log(`offline backlog check failed: ${(err as Error).message}`));
    }
    if (bound > 0) this.state.advance(bound);
  }

  private async loop(): Promise<void> {
    let backoff = 2_000;
    let needsRegister = false;
    while (!this.stopped) {
      try {
        if (needsRegister) {
          await this.register();
          needsRegister = false;
        }
        const { events } = await this.client.events(this.queueId!, this.lastEventId);
        backoff = 2_000;
        for (const e of events) {
          this.lastEventId = Math.max(this.lastEventId, e.id);
          this.onEvent(e);
        }
      } catch (err) {
        if (err instanceof ZulipApiError && err.code === 'BAD_EVENT_QUEUE_ID') {
          log('event queue expired — re-registering (messages in the gap are treated as offline)');
          needsRegister = true;
          continue;
        }
        log(`${needsRegister ? 're-register' : 'event poll'} failed: ${(err as Error).message} — retrying in ${backoff / 1000}s`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private onEvent(e: ZulipEvent): void {
    if (e.type === 'message' && e.message) {
      const m = e.message;
      const flags = e.flags ?? [];
      this.state.advance(m.id);
      if (this.actions.isHand(m.sender_id)) this.actions.noteActivity(m.sender_id, 'message');
      this.intake = this.intake
        .then(() => this.onMessage(m, flags))
        .catch((err) => log(`message ${m.id}: ${(err as Error).stack ?? err}`));
    } else if (e.type === 'reaction' && e.op === 'add' && typeof e.user_id === 'number') {
      if (this.actions.isHand(e.user_id)) this.actions.noteActivity(e.user_id, 'reaction');
    }
  }

  /** Is this message addressed to the spawner as a command? A stream message
   *  needs Zulip's own `mentioned` flag (a real, non-silent mention outside
   *  code/quotes) AND the mention as its first characters. */
  private isCommand(m: ZulipMessage, flags: string[]): boolean {
    if (m.sender_id === this.me.user_id) return false;
    if (m.type === 'private') return true;
    return flags.includes('mentioned') && startsWithMention(m.content, this.me.full_name, this.me.user_id);
  }

  private whereOf(m: ZulipMessage): Where {
    if (m.type === 'stream') {
      return { kind: 'stream', streamName: String(m.display_recipient), streamId: m.stream_id ?? 0, topic: m.subject };
    }
    const people = Array.isArray(m.display_recipient) ? m.display_recipient.map((r) => r.id) : [m.sender_id];
    const others = people.filter((id) => id !== this.me.user_id);
    return { kind: 'dm', userIds: others.length ? others : [m.sender_id] };
  }

  private async userInfo(id: number): Promise<{ isBot: boolean; name: string }> {
    const hit = this.users.get(id);
    if (hit) return hit;
    const { user } = await this.client.user(id);
    const info = { isBot: user.is_bot, name: user.full_name };
    this.users.set(id, info);
    return info;
  }

  private async onMessage(m: ZulipMessage, flags: string[]): Promise<void> {
    if (!this.isCommand(m, flags)) return;

    const body = stripMentions(m.content);
    const cmd = parseCommand(body);
    const info = await this.userInfo(m.sender_id).catch(() => ({ isBot: true, name: m.sender_full_name }));
    const invoker: Invoker = { userId: m.sender_id, name: info.name, kind: info.isBot ? 'resident' : 'user' };
    // Loop guard: a bot gets replies only for real commands.
    if (invoker.kind === 'resident' && cmd.kind === 'help') {
      log(`ignoring non-command mention from bot ${invoker.userId}: ${JSON.stringify(body.slice(0, 120))}`);
      return;
    }
    const where = this.whereOf(m);
    let result: ActionResult;
    try {
      result = await this.actions.run({ cmd, body, where, invoker });
    } catch (err) {
      // Never leave a command unanswered: the asker sees the failure, the log the stack.
      log(`command failed (message ${m.id}): ${(err as Error).stack ?? err}`);
      const why = String((err as Error).message ?? err).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' — ');
      result = { content: `⚠️ That failed: ${why.slice(0, 300)}` };
    }
    if (result.private) {
      await this.notifier.dm([m.sender_id], result.content);
      if (where.kind === 'stream') await this.notifier.reply(where, `@_**${invoker.name}|${invoker.userId}** 📬 sent you a DM.`);
      return;
    }
    const content = where.kind === 'stream' ? `@_**${invoker.name}|${invoker.userId}** ${result.content}` : result.content;
    await this.notifier.reply(where, content);
  }

  /** Commands that arrived while the spawner was not listening: never run
   *  stale spawns/stops; one bounded notice per topic/DM. */
  private async answerStale(since: number, bound: number): Promise<void> {
    const stale = new Map<string, { count: number; latest: ZulipMessage }>();
    const seen = new Set<number>(); // a DM can also be a mention
    for (const narrow of [[{ operator: 'is', operand: 'mentioned' }], [{ operator: 'is', operand: 'dm' }]]) {
      let anchor = since;
      for (;;) {
        const page = await this.client.messages(narrow, anchor, 0, PAGE, false);
        const fresh = page.filter((m) => m.id > since && m.id <= bound && !seen.has(m.id));
        for (const m of fresh) {
          seen.add(m.id);
          if (!this.isCommand(m, m.flags ?? [])) continue;
          const cmd = parseCommand(stripMentions(m.content));
          if (cmd.kind !== 'spawn' && cmd.kind !== 'stop') continue;
          const where = this.whereOf(m);
          if (where.kind === 'stream' && !streamAllowed(where.streamName, this.config)) continue;
          const key = where.kind === 'stream' ? `s:${where.streamId}:${where.topic.toLowerCase()}` : `d:${where.userIds.sort().join(',')}`;
          const batch = stale.get(key);
          if (batch) {
            batch.count += 1;
            if (m.id > batch.latest.id) batch.latest = m;
          } else stale.set(key, { count: 1, latest: m });
        }
        const last = page[page.length - 1]?.id;
        if (page.length < PAGE || last === undefined || last >= bound || last <= anchor) break;
        anchor = last;
      }
    }
    let posted = 0;
    for (const { count, latest } of stale.values()) {
      if (posted++ >= MAX_STALE_NOTICES) break;
      const noun = count === 1 ? 'a command' : `${count} commands`;
      await this.notifier.reply(this.whereOf(latest), `I wasn't listening when ${noun} arrived here — I ignored ${count === 1 ? 'it' : 'them'}. Re-issue anything still wanted.`);
    }
  }
}
