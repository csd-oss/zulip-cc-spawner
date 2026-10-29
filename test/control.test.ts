import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ActionResult, Invocation, SpawnerActions } from '../src/actions.js';
import type { Where } from '../src/auth.js';
import { ControlState, ZulipControl } from '../src/control.js';
import type { Notifier } from '../src/notifier.js';
import { ZulipApiError, type ZulipClient, type ZulipEvent, type ZulipMessage } from '../src/zulip.js';
import { testConfig, tmp } from './helpers.js';

const ME = { user_id: 42, full_name: 'CC Spawner', email: 'spawner-bot@example.org', is_bot: true, role: 400 };

function msg(id: number, content: string, extra: Partial<ZulipMessage> = {}): ZulipMessage {
  return {
    id,
    type: 'stream',
    sender_id: 1,
    sender_full_name: 'Tester',
    sender_email: 'tester@example.org',
    content,
    subject: 'release',
    stream_id: 7,
    display_recipient: 'cc-hands',
    timestamp: 1,
    ...extra,
  };
}

/** Event batches are handed out one per poll; then the poll parks until stop. */
class FakeZulip {
  batches: (ZulipEvent[] | Error)[] = [];
  backlog: ZulipMessage[] = [];
  registers = 0;
  maxMessageId = 20;
  bots = new Set<number>([500]);
  async me() {
    return ME;
  }
  registerFailures = 0;
  userDelay = new Map<number, number>();
  async register() {
    if (this.registerFailures > 0) {
      this.registerFailures--;
      this.registers++;
      throw new Error('502 Bad Gateway');
    }
    this.registers++;
    return { queue_id: `q${this.registers}`, last_event_id: -1, max_message_id: this.maxMessageId };
  }
  async events(): Promise<{ events: ZulipEvent[] }> {
    const next = this.batches.shift();
    if (next instanceof Error) throw next;
    if (next) return { events: next };
    await new Promise((r) => setTimeout(r, 50));
    return { events: [] };
  }
  async messages(narrow: { operand: string }[]) {
    return this.backlog.filter((m) => (narrow[0].operand === 'dm' ? m.type === 'private' : m.type === 'stream'));
  }
  async user(id: number) {
    const d = this.userDelay.get(id);
    if (d) await new Promise((r) => setTimeout(r, d));
    return { user: { user_id: id, full_name: id === 500 ? 'Helper Bot' : 'Tester', email: '', is_bot: this.bots.has(id), is_active: true } };
  }
}

class Spy implements Notifier {
  out: { to: string; content: string }[] = [];
  async postHome(e: { streamName: string; topic: string }, content: string) {
    this.out.push({ to: `#${e.streamName}>${e.topic}`, content });
    return 1;
  }
  async reply(w: Where, content: string) {
    this.out.push({ to: w.kind === 'stream' ? `#${w.streamName}>${w.topic}` : `dm:${w.userIds.join(',')}`, content });
  }
  async dm(ids: number[], content: string) {
    this.out.push({ to: `dm:${ids.join(',')}`, content });
  }
}

function setup(lastSeen?: number) {
  const dir = tmp();
  const zulip = new FakeZulip();
  const notifier = new Spy();
  const runs: Invocation[] = [];
  const activity: number[] = [];
  let result: ActionResult | Error = { content: 'ok' };
  const actions = {
    run: async (inv: Invocation) => {
      runs.push(inv);
      if (result instanceof Error) throw result;
      return result;
    },
    isHand: (id: number) => id === 100,
    noteActivity: (id: number) => activity.push(id),
  } as unknown as SpawnerActions;
  const state = new ControlState(join(dir, 'state.json'));
  if (lastSeen !== undefined) state.advance(lastSeen);
  const control = new ZulipControl(zulip as unknown as ZulipClient, actions, notifier, testConfig(dir), state);
  return { zulip, notifier, runs, activity, control, state, setResult: (r: ActionResult | Error) => (result = r) };
}

const settle = () => new Promise((r) => setTimeout(r, 300));

test('commands must start with the spawner mention; replies go to the topic', async () => {
  const s = setup();
  s.zulip.batches.push([
    { id: 1, type: 'message', message: msg(21, '@**CC Spawner** list'), flags: ['mentioned'] },
    { id: 2, type: 'message', message: msg(22, 'hey @**CC Spawner** stop scout'), flags: ['mentioned'] },
  ]);
  await s.control.start();
  await settle();
  s.control.stop();
  assert.equal(s.runs.length, 1);
  assert.deepEqual(s.runs[0].cmd, { kind: 'list' });
  assert.deepEqual(s.runs[0].where, { kind: 'stream', streamName: 'cc-hands', streamId: 7, topic: 'release' });
  assert.deepEqual(s.notifier.out, [{ to: '#cc-hands>release', content: '@_**Tester|1** ok' }]);
  assert.equal(s.state.lastSeenMessageId, 22);
});

test('DMs are commands; private results go by DM', async () => {
  const s = setup();
  s.setResult({ content: 'terminal tail', private: true });
  s.zulip.batches.push([
    { id: 1, type: 'message', message: msg(21, 'peek scout', { type: 'private', display_recipient: [{ id: 1, email: '', full_name: 'Tester' }, { id: 42, email: '', full_name: 'CC Spawner' }] }) },
  ]);
  await s.control.start();
  await settle();
  s.control.stop();
  assert.equal(s.runs[0].where.kind, 'dm');
  assert.deepEqual(s.notifier.out, [{ to: 'dm:1', content: 'terminal tail' }]);
});

test('bots get no reply for non-commands; hands post activity', async () => {
  const s = setup();
  s.zulip.batches.push([
    { id: 1, type: 'message', message: msg(21, '@**CC Spawner** thanks!', { sender_id: 500 }), flags: ['mentioned'] },
    { id: 2, type: 'message', message: msg(22, 'hello all', { sender_id: 100 }) },
    { id: 3, type: 'reaction', op: 'add', user_id: 100, message_id: 22 },
  ]);
  await s.control.start();
  await settle();
  s.control.stop();
  assert.equal(s.runs.length, 0);
  assert.deepEqual(s.activity, [100, 100]);
});

test('offline commands are never run; one notice per topic', async () => {
  const s = setup(10);
  const m = (id: number, text: string, extra: Partial<ZulipMessage> = {}) => msg(id, text, { flags: ['mentioned'], ...extra });
  s.zulip.backlog = [
    m(12, '@**CC Spawner** spawn opus-5-5'),
    m(14, '@**CC Spawner** stop scout'),
    m(15, '@**CC Spawner** list'),
    m(16, '@**CC Spawner** spawn opus-5-5', { display_recipient: 'general', stream_id: 1 }),
    m(9, '@**CC Spawner** spawn opus-5-5'),
    msg(17, '@**CC Spawner** stop other'), // no mentioned flag (e.g. inside a code block) — not a command
  ];
  await s.control.start();
  await settle();
  s.control.stop();
  assert.equal(s.runs.length, 0);
  assert.equal(s.notifier.out.length, 1, 'one notice, and none in a stream that is not allow-listed');
  assert.match(s.notifier.out[0].content, /2 commands arrived here — I ignored them/);
  assert.equal(s.state.lastSeenMessageId, 20);
});

test('an expired event queue is re-registered', async () => {
  const s = setup();
  s.zulip.batches.push(new ZulipApiError('Bad event queue id', 'BAD_EVENT_QUEUE_ID', 400));
  s.zulip.batches.push([{ id: 1, type: 'message', message: msg(30, '@**CC Spawner** rescan'), flags: ['mentioned'] }]);
  await s.control.start();
  await settle();
  s.control.stop();
  assert.equal(s.zulip.registers, 2);
  assert.deepEqual(s.runs[0].cmd, { kind: 'rescan' });
});

test('code blocks, quotes, silent and mid-sentence mentions never run', async () => {
  const s = setup();
  const texts = [
    '    @**CC Spawner** stop scout',
    '\t@**CC Spawner** stop scout',
    '> @**CC Spawner** stop scout',
    '```\n@**CC Spawner** stop scout\n```',
    '@_**CC Spawner** stop scout',
    'so @**CC Spawner** stop scout',
  ];
  s.zulip.batches.push(texts.map((t, i) => ({ id: i + 1, type: 'message', message: msg(30 + i, t), flags: ['mentioned'] })));
  // Zulip sets no `mentioned` flag for a mention inside code — even at column 0.
  s.zulip.batches.push([{ id: 9, type: 'message', message: msg(40, '@**CC Spawner** stop scout'), flags: [] }]);
  await s.control.start();
  await settle();
  s.control.stop();
  assert.equal(s.runs.length, 0);
});

test('commands execute in arrival order even when a lookup is slow', async () => {
  const s = setup();
  s.zulip.userDelay.set(1, 80);
  s.zulip.batches.push([
    { id: 1, type: 'message', message: msg(21, '@**CC Spawner** spawn opus-5-5 name=a'), flags: ['mentioned'] },
    { id: 2, type: 'message', message: msg(22, '@**CC Spawner** stop a', { sender_id: 2 }), flags: ['mentioned'] },
  ]);
  await s.control.start();
  for (let i = 0; i < 100 && s.runs.length < 2; i++) await new Promise((r) => setTimeout(r, 30));
  s.control.stop();
  assert.deepEqual(s.runs.map((r) => r.cmd.kind), ['spawn', 'stop']);
});

test('a failing re-registration backs off instead of hammering', async () => {
  const s = setup();
  s.zulip.batches.push(new ZulipApiError('Bad event queue id', 'BAD_EVENT_QUEUE_ID', 400));
  s.zulip.registerFailures = 0;
  await s.control.start();
  s.zulip.registerFailures = 50; // every re-register fails from now on
  await new Promise((r) => setTimeout(r, 300));
  s.control.stop();
  // 1 initial + 1 failed attempt, then a 2s backoff: no tight loop.
  assert.ok(s.zulip.registers <= 3, `registers=${s.zulip.registers}`);
});

test('backlog paging excludes the anchor and counts each message once', async () => {
  const s = setup(0);
  s.zulip.maxMessageId = 300;
  const all = Array.from({ length: 150 }, (_, i) => msg(i + 1, '@**CC Spawner** stop x', { flags: ['mentioned'] }));
  const anchors: { anchor: number; include: boolean }[] = [];
  s.zulip.messages = async (narrow: { operand: string }[], anchor: number, _b: number, after: number, include = true) => {
    anchors.push({ anchor, include });
    if (narrow[0].operand === 'dm') return [];
    return all.filter((m) => (include ? m.id >= anchor : m.id > anchor)).slice(0, after);
  };
  await s.control.start();
  await settle();
  s.control.stop();
  assert.ok(anchors.every((a) => a.include === false));
  assert.match(s.notifier.out[0].content, /150 commands arrived/);
});

test('a command that throws is answered with the failure, not silence', async () => {
  const s = setup();
  s.setResult(new Error('Command failed: sudo -n -H -u cc-agents -- tmux has-session -t =x\nno current target\n    at genericNodeError'));
  s.zulip.batches.push([{ id: 1, type: 'message', message: msg(21, '@**CC Spawner** spawn sonnet-5-5 name=x'), flags: ['mentioned'] }]);
  await s.control.start();
  await settle();
  s.control.stop();
  assert.deepEqual(s.notifier.out, [
    { to: '#cc-hands>release', content: '@_**Tester|1** ⚠️ That failed: Command failed: sudo -n -H -u cc-agents -- tmux has-session -t =x — no current target' },
  ]);
});
