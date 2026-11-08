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

/** Exercise the real control intake seam without polling or network access. */
async function messageEvent(s: ReturnType<typeof setup>, timestamp: number): Promise<void> {
  const control = new ZulipControl({} as ZulipClient, s.actions, s.notifier, testConfig(s.dir), new ControlState(join(s.dir, 'cursor.json')));
  const intake = control as unknown as { me: { user_id: number; full_name: string }; onEvent(e: ZulipEvent): void; intake: Promise<void> };
  intake.me = { user_id: 42, full_name: 'CC Spawner' };
  intake.onEvent({ id: 1, type: 'message', message: {
    id: 10, type: 'stream', sender_id: 100, sender_email: s.entry.botEmail, sender_full_name: 'fuzzer',
    content: 'skewed clock', subject: 'home', stream_id: 7, display_recipient: 'cc-hands', timestamp,
  } });
  await intake.intake;
}

test('silence: future message event cannot prove startup during provisioning', async (t) => {
  const receivedAt = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => receivedAt);
  let lookups = 0;
  const s = setup(async () => { lookups++; return undefined; });
  s.registry.update(s.entry, { status: 'provisioning' });
  const previous = s.entry.lastActivity;
  await messageEvent(s, (receivedAt + 48 * 3600_000) / 1000);
  assert.equal(s.entry.firstPostAt, undefined, 'future traffic is not proof of a new launch');
  assert.equal(s.entry.lastActivity, previous);
  s.registry.update(s.entry, { status: 'alive' });
  await s.reaper.sweep();
  assert.equal(lookups, 1);
  assert.match(s.posts[0], /has not posted anything/);
});

test('reaping: future message event cannot bypass authoritative history after 25h', async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  let lookups = 0;
  const s = setup(async () => { lookups++; return undefined; });
  await messageEvent(s, (now + 48 * 3600_000) / 1000);
  now += 25 * 3600_000;
  await s.reaper.sweep();
  assert.equal(s.entry.status, 'reaped');
  assert.equal(s.kills(), 1);
  assert.ok(lookups > 0, 'idle reaping must consult authoritative history');
});

test('silence: future history cannot prove startup', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const s = setup(async () => now + 48 * 3600_000);
  await s.reaper.sweep();
  assert.equal(s.entry.firstPostAt, undefined);
  assert.equal(s.entry.silenceWarned, true);
  assert.match(s.posts[0], /has not posted anything/);
});

test('reaping: future history cannot renew an idle hand', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  let lookups = 0;
  const s = setup(async () => { lookups++; return now + 48 * 3600_000; });
  const previous = new Date(now - 25 * 3600_000).toISOString();
  s.registry.update(s.entry, { firstPostAt: s.entry.spawnedAt, lastActivity: previous });
  await s.reaper.sweep();
  assert.equal(s.entry.status, 'reaped');
  assert.equal(s.entry.lastActivity, previous);
  assert.equal(lookups, 1);
  assert.equal(s.kills(), 1);
});

for (const source of ['event', 'history'] as const) {
  for (const skew of [60_000, 60_001]) {
    test(`silence: ${source} clock skew of ${skew}ms is ${skew === 60_000 ? 'accepted' : 'rejected'}`, async (t) => {
      const now = 1_800_000_000_000;
      t.mock.method(Date, 'now', () => now);
      const posted = now + skew;
      const s = setup(async () => source === 'history' ? posted : undefined);
      const previous = s.entry.lastActivity;
      if (source === 'event') s.actions.noteActivity(100, 'message', posted / 1000);
      await s.reaper.sweep();
      assert.equal(s.entry.firstPostAt, skew === 60_000 ? new Date(posted).toISOString() : undefined);
      assert.equal(s.entry.silenceWarned, skew === 60_000 ? undefined : true);
      // Startup history proves the post but does not update the idle watermark.
      assert.equal(s.entry.lastActivity, source === 'event' && skew === 60_000 ? new Date(posted).toISOString() : previous);
    });
  }
}

test('silence: malformed history timestamps never prove startup or block reaping', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  for (const posted of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
    const s = setup(async () => posted);
    s.registry.update(s.entry, { lastActivity: new Date(now - 25 * 3600_000).toISOString() });
    await s.reaper.sweep();
    assert.equal(s.entry.firstPostAt, undefined);
    assert.equal(s.entry.silenceWarned, true);
    assert.equal(s.entry.status, 'reaped');
  }
});

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
    content: 'hello', subject: 'home', stream_id: 7, display_recipient: 'cc-hands', timestamp: Math.floor(Date.now() / 1000),
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

test('silence: delayed old-launch message during provisioning revival still warns', async () => {
  const s = setup();
  const old = { ...s.entry, status: 'reaped' as const, sessionId: 'old' };
  const registry = new Registry(join(s.dir, 'revived.json'));
  registry.add(old);
  registry.add(s.entry);
  registry.update(s.entry, { status: 'provisioning' });
  const previous = s.entry.lastActivity;
  const timestamp = Math.floor(Date.parse(s.entry.spawnedAt) / 1000) - 60;
  const actions = new SpawnerActions({ registry } as ActionDeps);
  const control = new ZulipControl({} as ZulipClient, actions, s.notifier, testConfig(s.dir), new ControlState(join(s.dir, 'cursor.json')));
  const intake = control as unknown as { me: { user_id: number; full_name: string }; onEvent(e: ZulipEvent): void; intake: Promise<void> };
  intake.me = { user_id: 42, full_name: 'CC Spawner' };
  intake.onEvent({ id: 1, type: 'message', message: {
    id: 10, type: 'stream', sender_id: 100, sender_email: s.entry.botEmail, sender_full_name: 'fuzzer',
    content: 'previous launch', subject: 'home', stream_id: 7, display_recipient: 'cc-hands', timestamp,
  } });
  await intake.intake;
  registry.update(s.entry, { status: 'alive' });
  let lookups = 0;
  const reaper = new Reaper(registry, { hasSession: async () => true } as unknown as Tmux, s.notifier, { inactivityMs: 24 * 3600_000 }, async () => { lookups++; return timestamp * 1000; });
  await reaper.sweep();
  await reaper.sweep();
  assert.equal(s.posts.length, 1, 'an old launch must not suppress the new launch warning');
  assert.match(s.posts[0], /has not posted anything/);
  assert.equal(lookups, 1);
  assert.equal(s.entry.firstPostAt, undefined);
  assert.equal(s.entry.lastActivity, previous, 'stale delivery is not current activity');
  assert.equal(old.firstPostAt, undefined);
  assert.equal(old.lastActivity, previous);
});

test('silence: provisioning reactions cannot credit an unproven revival', () => {
  const s = setup();
  s.registry.update(s.entry, { status: 'provisioning' });
  const previous = s.entry.lastActivity;
  s.actions.noteActivity(100, 'reaction');
  assert.equal(s.entry.lastActivity, previous);
  assert.equal(s.entry.firstPostAt, undefined);
});

test('silence: alive reactions use receipt time but never prove a first post or move activity backwards', (t) => {
  const s = setup();
  const now = Date.parse(s.entry.spawnedAt) + 60_000;
  t.mock.method(Date, 'now', () => now);
  s.actions.noteActivity(100, 'reaction');
  assert.equal(s.entry.lastActivity, new Date(now).toISOString());
  assert.equal(s.entry.firstPostAt, undefined);
  s.registry.update(s.entry, { lastActivity: new Date(now + 1000).toISOString() });
  s.actions.noteActivity(100, 'reaction');
  assert.equal(s.entry.lastActivity, new Date(now + 1000).toISOString());
});

test('silence: same-second provisioning post counts without moving activity backwards', () => {
  const s = setup();
  const timestamp = Math.floor(Date.parse(s.entry.spawnedAt) / 1000);
  const spawnedAt = new Date(timestamp * 1000 + 999).toISOString();
  s.registry.update(s.entry, { status: 'provisioning', spawnedAt, lastActivity: spawnedAt });
  s.actions.noteActivity(100, 'message', timestamp);
  assert.equal(s.entry.firstPostAt, new Date(timestamp * 1000).toISOString());
  assert.equal(s.entry.lastActivity, spawnedAt);
});

test('silence: fallback also accepts a same-second startup post', async () => {
  const s = setup();
  const posted = Math.floor(Date.parse(s.entry.spawnedAt) / 1000) * 1000;
  s.registry.update(s.entry, { spawnedAt: new Date(posted + 999).toISOString() });
  const reaper = new Reaper(s.registry, { hasSession: async () => true } as unknown as Tmux, s.notifier, { inactivityMs: 24 * 3600_000 }, async () => posted);
  await reaper.sweep();
  assert.equal(s.entry.firstPostAt, new Date(posted).toISOString());
  assert.deepEqual(s.posts, []);
});

test('silence: alive pre-launch messages do not renew activity or prove startup', () => {
  const s = setup();
  const previous = s.entry.lastActivity;
  s.actions.noteActivity(100, 'message', Math.floor(Date.parse(s.entry.spawnedAt) / 1000) - 1);
  assert.equal(s.entry.lastActivity, previous);
  assert.equal(s.entry.firstPostAt, undefined);
});

test('silence: out-of-order current-launch messages use event time and retain the activity watermark', () => {
  const s = setup();
  const timestamp = Math.floor(Date.parse(s.entry.spawnedAt) / 1000) + 60;
  s.actions.noteActivity(100, 'message', timestamp);
  const postedAt = new Date(timestamp * 1000).toISOString();
  assert.equal(s.entry.firstPostAt, postedAt);
  assert.equal(s.entry.lastActivity, postedAt, 'delayed delivery must not credit receipt time');
  s.actions.noteActivity(100, 'message', timestamp - 30);
  assert.equal(s.entry.firstPostAt, postedAt);
  assert.equal(s.entry.lastActivity, postedAt);
});

test('reaping: a delayed current-launch message cannot make an idle hand look active now', async () => {
  const s = setup();
  const timestamp = Math.floor((Date.now() - 25 * 3600_000) / 1000);
  s.registry.update(s.entry, { spawnedAt: new Date((timestamp - 60) * 1000).toISOString(), lastActivity: new Date((timestamp - 60) * 1000).toISOString() });
  s.actions.noteActivity(100, 'message', timestamp);
  await s.reaper.sweep();
  assert.equal(s.entry.status, 'reaped');
  assert.equal(s.kills(), 1);
});

test('silence: malformed message timestamps do not credit receipt time', () => {
  const s = setup();
  const previous = s.entry.lastActivity;
  for (const timestamp of [NaN, Infinity, -Infinity, Number.MAX_VALUE, undefined]) {
    s.actions.noteActivity(100, 'message', timestamp as number);
  }
  assert.equal(s.entry.lastActivity, previous);
  assert.equal(s.entry.firstPostAt, undefined);
});

test('silence: stopped history and unknown senders do not mark a current hand as posted', () => {
  const s = setup();
  s.actions.noteActivity(999, 'message', Math.floor(Date.now() / 1000));
  assert.equal(s.entry.firstPostAt, undefined);
  s.registry.update(s.entry, { status: 'reaped' });
  s.actions.noteActivity(100, 'message', Math.floor(Date.now() / 1000));
  assert.equal(s.entry.firstPostAt, undefined);
});

test('silence: traffic under a different identity cannot prove this bot posted', async () => {
  const s = setup(); // Registered bot's history is empty.
  s.actions.noteActivity(999, 'message', Math.floor(Date.now() / 1000)); // A bridge posting as another account.
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
    s.actions.noteActivity(100, 'message', Math.floor(Date.now() / 1000));
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
