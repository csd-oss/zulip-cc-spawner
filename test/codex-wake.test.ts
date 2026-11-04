import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexWake } from '../src/codex-wake.js';
import { QUEUE_FAILURE } from '../src/codex.js';
import type { Registry, BotEntry } from '../src/registry.js';
import type { ZulipMessage } from '../src/zulip.js';

const message = (id: number, mentioned = false) => ({
  id, type: 'stream', stream_id: 7, subject: 'topic', sender_id: 1,
  sender_full_name: 'Tester', content: String(id), flags: mentioned ? ['mentioned'] : [],
} as ZulipMessage);

function fixture(lookup: (id: number) => Promise<ZulipMessage>, queue = async (_text: string) => {}, now = Date.now) {
  const e = { engine: 'codex', status: 'alive', streamId: 7, streamName: 'home',
    topic: 'topic', botUserId: 42, sessionId: 'id' } as BotEntry;
  const posts: string[] = [], queued: string[] = [];
  let reads = 0;
  const wake = new CodexWake({ alive: () => [e] } as unknown as Registry,
    { async postHome(_e, text) { posts.push(text); return 1; }, async reply() {}, async dm() {} },
    async (_e, id) => { reads++; return lookup(id); },
    async (_e, text) => { queued.push(text); await queue(text); }, async () => {}, now);
  return { wake, posts, queued, reads: () => reads };
}

test('ambient burst cannot fill addressed backlog; newest real mention survives intake coalescing', async () => {
  const f = fixture(async (id) => message(id, id === 26));
  for (let id = 1; id <= 26; id++) f.wake.onMessage(message(id));
  await f.wake.drain();
  assert.equal(f.reads(), 20);
  assert.equal(f.queued.length, 1);
  assert.match(f.queued[0], /\n26$/);
  assert.deepEqual(f.posts, []);
});

test('ambient-only overflow never posts public failures', async () => {
  const f = fixture(async (id) => message(id));
  for (let id = 1; id <= 25; id++) f.wake.onMessage(message(id));
  await f.wake.drain();
  assert.equal(f.reads(), 20);
  assert.deepEqual(f.queued, []);
  assert.deepEqual(f.posts, []);
});

test('candidate lookup failures on unaddressed traffic stay console-only', async () => {
  const f = fixture(async () => { throw new Error('lookup unavailable'); });
  f.wake.onMessage(message(1));
  await f.wake.drain();
  assert.deepEqual(f.posts, []);
  assert.deepEqual(f.queued, []);
});

test('confirmed wake overflow notices coalesce per hand per interval', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((r) => { release = r; });
  let now = 0;
  const f = fixture(async (id) => message(id, true), async () => blocked, () => now);
  // Allow addressing intake to drain each time; only the addressed queue fills.
  const send = async (id: number) => {
    f.wake.onMessage(message(id));
    await new Promise<void>((r) => setImmediate(r));
  };
  for (let id = 1; id <= 25; id++) await send(id);
  assert.deepEqual(f.posts, [QUEUE_FAILURE]);
  now = 59_999;
  await send(26);
  assert.equal(f.posts.length, 1);
  now = 60_000;
  await send(27);
  await send(28);
  assert.deepEqual(f.posts, [QUEUE_FAILURE, QUEUE_FAILURE]);
  release();
  await f.wake.drain();
  assert.equal(f.queued.length, 20);
});
