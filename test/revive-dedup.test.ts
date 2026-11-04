import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CodexWake } from '../src/codex-wake.js';
import { buildResumePrompt, buildSeedPrompt } from '../src/handfiles.js';
import { Registry, type BotEntry } from '../src/registry.js';
import type { ZulipMessage } from '../src/zulip.js';
import { tmp } from './helpers.js';

test('baseline reproduction: resume backscroll and live wake overlap', async () => {
  const registry = new Registry(join(tmp(), 'registry.json'));
  const e = { engine: 'codex', status: 'alive', streamId: 7, streamName: 'home', topic: 'topic', botUserId: 42, sessionId: 'id' } as BotEntry;
  registry.add(e);
  const m = { id: 11, type: 'stream', stream_id: 7, subject: 'topic', sender_id: 1, sender_full_name: 'Tester', content: 'question', flags: ['mentioned'] } as ZulipMessage;
  const seed = buildResumePrompt({ personaName: 'hand', streamName: 'home', topic: 'topic', realm: 'offline' });
  const deliveries: string[] = [];
  const wake = new CodexWake(registry, { async postHome() { return 1; }, async reply() {}, async dm() {} },
    async () => m, async () => { deliveries.push('queue'); }, async () => {});
  wake.onMessage(m);
  // Deterministic fake reader follows the unbounded production resume instruction.
  assert.match(seed, /catch up on the recent backscroll/);
  deliveries.push('backscroll');
  await wake.drain();
  assert.deepEqual(deliveries, ['backscroll', 'queue']);
});

import { readFileSync } from 'node:fs';
import { SpawnerActions } from '../src/actions.js';
import { parseCommand } from '../src/commands.js';
import { LocalHost } from '../src/host.js';
import type { Tmux } from '../src/tmux.js';
import type { Provisioner } from '../src/provision.js';
import type { ClaudeLauncher } from '../src/launcher.js';
import type { TranscriptWatcher } from '../src/transcript-watch.js';
import { testConfig } from './helpers.js';

for (const resume of [false, true]) test(`${resume ? 'revive' : 'fresh'} production startup partitions catch-up and buffered/live mentions`, async () => {
  const dir = tmp();
  const config = testConfig(dir);
  const registry = new Registry(join(dir, 'registry.json'));
  const host = new LocalHost();
  const realExec = host.exec.bind(host);
  host.exec = async (file, args, opts) => args[1]?.includes('discoverRollout')
    ? { stdout: '12345678-1234-1234-1234-123456789abc', stderr: '' }
    : realExec(file, args, opts);
  if (resume) registry.add({ suffix: 'test', personaName: '[cx-gpt-5] test', nameScheme: 'bracket-v1',
    engine: 'codex', model: 'gpt-5', botUserId: 42, status: 'reaped', streamId: 7,
    sessionId: '12345678-1234-1234-1234-123456789abc', tmuxSession: 'cx-gpt-5-test',
    handDir: join(dir, 'prior'), topic: 'topic', streamName: 'cc-hands',
  } as BotEntry);
  const message = (id: number) => ({ id, type: 'stream', stream_id: 7, subject: 'topic',
    sender_id: 1, sender_full_name: 'Tester', content: String(id), flags: ['mentioned'] } as ZulipMessage);
  const queued: number[] = [];
  const notifier = { async postHome() { return 1; }, async reply() {}, async dm() {} };
  const wake = new CodexWake(registry, notifier, async (_e, id) => message(id),
    async (e, text) => { assert.equal(e.status, 'alive'); assert.ok(e.sessionId); queued.push(Number(text.split('\n').at(-1))); }, async () => {});
  let running = false;
  let seed = '';
  const tmux = {
    async hasSession() { return running; },
    async newSession() {
      running = true;
      const e = registry.provisioning()[0];
      seed = readFileSync(e.seedFile, 'utf8');
      wake.onMessage(message(11)); // after snapshot, before readiness
      await Promise.resolve();
      assert.deepEqual(queued, []);
    },
    async capturePane() { return 'Ask Codex to do anything'; },
  } as unknown as Tmux;
  const actions = new SpawnerActions({ config, registry, host, tmux, notifier,
    launcher: {} as ClaudeLauncher, watcher: {} as TranscriptWatcher,
    provisioner: { async ensure() { return { bot: { userId: 42, email: 'hand@example.org', apiKey: 'fake' }, created: !resume }; },
      async subscribe() {}, credsFor() { return { email: 'hand@example.org', key: 'fake', site: 'offline' }; },
    } as unknown as Provisioner,
    groupCheck: async () => false, realm: 'offline', codexWake: wake,
    codexBoundary: async () => { wake.onMessage(message(10)); return 10; },
  });
  const result = await actions.run({ cmd: parseCommand('spawn gpt-5 name=test'), body: '',
    where: { kind: 'stream', streamId: 7, streamName: 'cc-hands', topic: 'topic' },
    invoker: { kind: 'user', userId: 1, name: 'Tester' } });
  assert.match(result.content, resume ? /Revived/ : /Spawned/);
  await wake.drain();
  assert.deepEqual(queued, [11]);
  assert.match(seed, /Catch-up boundary: message id <= 10/);
  assert.match(seed, /only still-unanswered mentions/);
  assert.ok(seed.includes("When answering a message found during catch-up, @-mention its sender using Zulip @**Name** syntax (replace Name with the sender's full name), just as for live mentions, so they receive a mention notification."));
  assert.match(seed, /do not repeat answers already in your earlier conversation or backscroll/);
  assert.match(seed, /Messages with id > 10 belong exclusively to the spawner wake queue/);
  // Fake reader obeys the seed contract: pre-stop answered 8 is context;
  // unanswered pre-stop 9 and downtime/startup 10 are catch-up-owned.
  const backscroll = [8, 9, 10, 11].filter((id) => id <= 10 && id !== 8);
  wake.onMessage(message(10)); // delayed event at the inclusive boundary
  wake.onMessage(message(12)); // normal live wake
  await wake.drain();
  assert.deepEqual([...backscroll, ...queued], [9, 10, 11, 12]);
  const reloaded = new Registry(join(dir, 'registry.json'));
  reloaded.load();
  assert.equal(reloaded.alive()[0].codexCatchupThrough, 10);
});

test('failed startup releases buffered intake without queueing; Claude is excluded', async () => {
  const registry = new Registry(join(tmp(), 'registry.json'));
  const e = { engine: 'codex', status: 'provisioning', streamId: 7, topic: 'topic' } as BotEntry;
  const claude = { ...e, engine: 'claude', status: 'alive' } as BotEntry;
  registry.add(e); registry.add(claude);
  let reads = 0;
  const wake = new CodexWake(registry, { async postHome() { return 1; }, async reply() {}, async dm() {} },
    async () => { reads++; return undefined; }, async () => { assert.fail('must not queue'); }, async () => {});
  wake.onMessage({ id: 11, type: 'stream', stream_id: 7, subject: 'topic', sender_id: 1 } as ZulipMessage);
  registry.update(e, { status: 'failed' });
  wake.ready(e);
  await wake.drain();
  assert.equal(reads, 0);
});

test('Claude seed and resume prompts remain byte-identical to pre-ADD1', () => {
  const ctx = { personaName: 'hand', streamName: 'home', topic: 'topic', realm: 'offline' };
  // SHA-256 snapshots captured at 67bca6e before the Codex-only prompt change.
  const cases = [
    [buildSeedPrompt(ctx), '0ed68e47856b24fbbf6104e593dd1435f0039530246f3e3d0eb26b1e0374ab7c'],
    [buildResumePrompt(ctx), '0e517c9b1a9b8f75206c66f976ddea1a016702100584beaae0a6d0e278523491'],
    [buildResumePrompt({ ...ctx, awaySince: 'yesterday' }), 'cb27128cf867201544a27bc719ea28a0c550bfa9f67a305c80e55dfc2fca66ae'],
  ];
  for (const [prompt, hash] of cases) {
    assert.equal(createHash('sha256').update(prompt).digest('hex'), hash);
    assert.ok(!prompt.includes('When answering a message found during catch-up'));
  }
});
