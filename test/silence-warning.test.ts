import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { SpawnerActions, type ActionDeps } from '../src/actions.js';
import { ControlState, ZulipControl } from '../src/control.js';
import type { Notifier } from '../src/notifier.js';
import { Reaper, SILENCE_WARN_MS, type LastPostLookup } from '../src/reaper.js';
import { Registry, type BotEntry } from '../src/registry.js';
import type { Tmux } from '../src/tmux.js';
import type { ZulipClient, ZulipEvent } from '../src/zulip.js';
import { testConfig, tmp } from './helpers.js';

function setup(lastPost: LastPostLookup = async () => undefined) {
  const dir = tmp();
  const registry = new Registry(join(dir, 'registry.json'));
  const spawnedAt = new Date(Date.now() - SILENCE_WARN_MS - 60_000).toISOString();
  const entry: BotEntry = {
    suffix: 'fuzzer', personaName: '[cc-opus-5-5] fuzzer', botUserId: 100, botEmail: 'fuzzer-bot@example.org',
    tmuxSession: 'cc-opus-5-5-fuzzer', streamName: 'cc-hands', streamId: 7, topic: 'home', handDir: dir,
    model: 'claude-opus-5-5', sessionId: 'sess', spawnedBy: { userId: 1, username: 'Tester' },
    spawnedAt, lastActivity: spawnedAt, status: 'alive', seedFile: join(dir, 'seed.md'),
  };
  registry.add(entry);
  const posts: string[] = [];
  const notifier = {
    postHome: async (_e: unknown, content: string) => { posts.push(content); return posts.length; },
    reply: async () => {}, dm: async () => {},
  } satisfies Notifier;
  let kills = 0;
  const tmux = { hasSession: async () => true, killSession: async () => { kills++; } } as unknown as Tmux;
  // Activity intake needs only the registry; no launcher or external clients run.
  const actions = new SpawnerActions({ registry } as ActionDeps);
  const reaper = new Reaper(registry, tmux, notifier, { inactivityMs: 24 * 3600_000 }, lastPost);
  return { dir, registry, entry, posts, notifier, actions, reaper, kills: () => kills };
}

for (const failure of ['owner bot list failed', '429 Too Many Requests', 'bot-key query failed', 'network unavailable']) {
  test(`silence: ${failure} defers warning and retries next sweep`, async (t) => {
    let calls = 0;
    const s = setup(async () => {
      if (++calls === 1) throw new Error(failure);
      return Date.now() - 60_000;
    });
    const logs: string[] = [];
    t.mock.method(console, 'log', (line: string) => logs.push(line));
    await s.reaper.sweep();
    assert.deepEqual(s.posts, [], 'uncertainty is not evidence of silence');
    assert.equal(s.entry.silenceWarned, undefined);
    assert.equal(s.entry.status, 'alive');
    assert.equal(s.kills(), 0);
    assert.ok(logs.some((line) => line.includes('fuzzer') && line.includes(failure)));
    await s.reaper.sweep();
    assert.equal(calls, 2);
    assert.ok(s.entry.firstPostAt);
    assert.deepEqual(s.posts, []);
  });
}

test('silence: lookup recovery confirming no posts still warns exactly once', async () => {
  let calls = 0;
  const s = setup(async () => {
    if (++calls === 1) throw new Error('temporary outage');
    return undefined;
  });
  await s.reaper.sweep();
  assert.deepEqual(s.posts, []);
  await s.reaper.sweep();
  await s.reaper.sweep();
  assert.equal(calls, 2);
  assert.equal(s.entry.silenceWarned, true);
  assert.equal(s.posts.length, 1);
  assert.match(s.posts[0], /has not posted anything/);
});

test('silence: provisioning message through control intake survives alive transition and reload', async () => {
  let lookups = 0;
  const s = setup();
  // Revival keeps an older entry with the same bot id: do not update history.
  const old = { ...s.entry, status: 'reaped' as const, firstPostAt: undefined };
  const registry = new Registry(join(s.dir, 'revived.json'));
  registry.add(old);
  registry.add(s.entry);
  registry.update(s.entry, { status: 'provisioning' });
  const actions = new SpawnerActions({ registry } as ActionDeps);
  const control = new ZulipControl({} as ZulipClient, actions, s.notifier, testConfig(s.dir), new ControlState(join(s.dir, 'cursor.json')));
  // Inject an actual event at the queue/intake seam (no polling/network).
  const intake = control as unknown as { me: { user_id: number; full_name: string }; onEvent(e: ZulipEvent): void; intake: Promise<void> };
  intake.me = { user_id: 42, full_name: 'CC Spawner' };
  intake.onEvent({ id: 1, type: 'message', message: {
    id: 10, type: 'stream', sender_id: 100, sender_email: s.entry.botEmail, sender_full_name: 'renamed fuzzer',
    content: 'hello', subject: 'home', stream_id: 7, display_recipient: 'cc-hands', timestamp: Date.now() / 1000,
  } });
  await intake.intake;
  // Activity intake is synchronous, even while spawn owns the action queue.
  registry.update(s.entry, { status: 'alive', lastActivity: new Date().toISOString() });
  const reloaded = new Registry(join(s.dir, 'revived.json'));
  reloaded.load();
  const reaper = new Reaper(reloaded, { hasSession: async () => true } as unknown as Tmux, s.notifier, { inactivityMs: 24 * 3600_000 }, async () => { lookups++; return undefined; });
  await reaper.sweep();
  assert.deepEqual(s.posts, [], 'an observed provisioning post must prevent a later warning');
  assert.ok(reloaded.alive()[0].firstPostAt);
  assert.equal(old.firstPostAt, undefined);
  assert.equal(lookups, 0, 'no fallback is needed once a message was observed');
});

test('silence: provisioning reactions count as activity, not proof of a message', () => {
  const s = setup();
  s.registry.update(s.entry, { status: 'provisioning' });
  const previous = s.entry.lastActivity;
  s.actions.noteActivity(100, 'reaction');
  assert.notEqual(s.entry.lastActivity, previous);
  assert.equal(s.entry.firstPostAt, undefined);
});

test('silence: stopped history and unknown senders do not mark a current hand as posted', () => {
  const s = setup();
  s.actions.noteActivity(999, 'message');
  assert.equal(s.entry.firstPostAt, undefined);
  s.registry.update(s.entry, { status: 'reaped' });
  s.actions.noteActivity(100, 'message');
  assert.equal(s.entry.firstPostAt, undefined);
});

test('silence: traffic under a different identity cannot prove this bot posted', async () => {
  const s = setup(); // Registered bot's history is empty.
  s.actions.noteActivity(999, 'message'); // A bridge posting as another account.
  await s.reaper.sweep();
  assert.equal(s.entry.firstPostAt, undefined);
  assert.equal(s.posts.length, 1, 'attribution uses bot id/key, not persona display name');
});

test('silence: missed queue traffic is recovered from the newest post, including timezone conversion', async () => {
  const posted = Date.parse('2026-11-06T21:36:00Z');
  const s = setup(async () => posted);
  s.registry.update(s.entry, { spawnedAt: '2026-11-06T22:21:00+01:00', lastActivity: new Date().toISOString() });
  await s.reaper.sweep();
  assert.equal(s.entry.firstPostAt, '2026-11-06T21:36:00.000Z');
  assert.deepEqual(s.posts, []);
});

test('silence: an older post from a revived identity is not proof of this launch', async () => {
  const s = setup(async () => Date.parse(s.entry.spawnedAt) - 1000);
  await s.reaper.sweep();
  assert.equal(s.posts.length, 1);
  assert.equal(s.entry.firstPostAt, undefined);
});

test('silence: a message observed while fallback is in flight prevents a warning', async () => {
  const s = setup(async () => {
    s.actions.noteActivity(100, 'message');
    return undefined; // Snapshot predates the event just received.
  });
  await s.reaper.sweep();
  assert.ok(s.entry.firstPostAt);
  assert.deepEqual(s.posts, []);
});

test('reaping: lookup errors still preserve an idle hand; confirmed silence still reaps', async () => {
  let fail = true;
  const s = setup(async () => {
    if (fail) throw new Error('lookup unavailable');
    return undefined;
  });
  s.registry.update(s.entry, { lastActivity: new Date(Date.now() - 25 * 3600_000).toISOString(), firstPostAt: s.entry.spawnedAt });
  await s.reaper.sweep();
  assert.equal(s.entry.status, 'alive');
  assert.equal(s.kills(), 0);
  fail = false;
  await s.reaper.sweep();
  assert.equal(s.entry.status, 'reaped');
  assert.equal(s.kills(), 1);
});
