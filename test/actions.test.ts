import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { SpawnerActions, type Invocation } from '../src/actions.js';
import type { Invoker, Where } from '../src/auth.js';
import { parseCommand } from '../src/commands.js';
import { LocalHost } from '../src/host.js';
import { ClaudeLauncher } from '../src/launcher.js';
import type { Notifier } from '../src/notifier.js';
import type { BotIdentity, Provisioner } from '../src/provision.js';
import { Registry } from '../src/registry.js';
import { Tmux } from '../src/tmux.js';
import { TranscriptWatcher, transcriptPath } from '../src/transcript-watch.js';
import { testConfig, tmp } from './helpers.js';

class FakeProvisioner {
  bots = new Map<string, BotIdentity>();
  subscribed: [number, string][] = [];
  failSubscribe = false;
  nextId = 100;
  async ensure(_full: string, short: string) {
    const existing = this.bots.get(short);
    if (existing) return { bot: existing, created: false };
    const bot = { userId: this.nextId++, email: `${short}-bot@example.org`, apiKey: `key-${short}` };
    this.bots.set(short, bot);
    return { bot, created: true };
  }
  async subscribe(userId: number, stream: string) {
    if (this.failSubscribe) throw new Error('subscription refused');
    this.subscribed.push([userId, stream]);
  }
  credsFor(bot: BotIdentity) {
    return { email: bot.email, key: bot.apiKey, site: 'https://chat.example.org' };
  }
}

class FakeNotifier implements Notifier {
  posts: string[] = [];
  async postHome(_e: unknown, content: string) {
    this.posts.push(content);
    return this.posts.length;
  }
  async reply(_w: Where, content: string) {
    this.posts.push(content);
  }
  async dm(_u: number[], content: string) {
    this.posts.push(content);
  }
}

const dir = tmp();
const cfg = testConfig(dir);
const host = new LocalHost();
const tmux = new Tmux(host, cfg.tmuxSocket);
const registry = new Registry(join(dir, 'registry.json'));
const provisioner = new FakeProvisioner();
const notifier = new FakeNotifier();
const watcher = new TranscriptWatcher(registry, host, tmux, notifier, { agentsHome: cfg.agentsHome, projectDir: cfg.projectDir }, () => 'CC Spawner');
const actions = new SpawnerActions({
  config: cfg,
  registry,
  host,
  tmux,
  provisioner: provisioner as unknown as Provisioner,
  launcher: new ClaudeLauncher(cfg, tmux),
  notifier,
  watcher,
  groupCheck: async () => false,
  realm: 'https://chat.example.org',
});
after(async () => {
  for (const s of await tmux.listSessions()) await tmux.killSession(s);
});

const tester: Invoker = { userId: 1, name: 'Tester', kind: 'user' };
const home: Where = { kind: 'stream', streamName: 'cc-hands', streamId: 7, topic: 'release' };
const run = (text: string, where: Where = home, invoker: Invoker = tester) =>
  actions.run({ cmd: parseCommand(text), body: text, where, invoker } satisfies Invocation);

test('spawn provisions a bot, writes its files and starts claude', async () => {
  const r = await run('spawn opus-5-5 name=Scout effort=high');
  assert.match(r.content, /Spawned @\*\*Claude-Code-opus-5-5-scout\*\*/);
  const e = registry.findAlive('scout')!;
  assert.equal(e.status, 'alive');
  assert.equal(e.botUserId, 100);
  assert.equal(e.streamId, 7);
  assert.deepEqual(provisioner.subscribed, [[100, 'cc-hands']]);
  assert.ok(await tmux.hasSession('cc-opus-5-5-scout'));

  const handDir = join(cfg.handsDir, 'cc-opus-5-5-scout');
  assert.equal(statSync(join(handDir, 'zuliprc')).mode & 0o777, 0o600);
  assert.match(readFileSync(join(handDir, 'zuliprc'), 'utf8'), /key=key-cc-opus-5-5-scout/);
  const bridge = JSON.parse(readFileSync(join(handDir, 'mcpl-bridge.json'), 'utf8'));
  const z = bridge.servers.zulip;
  assert.deepEqual(z.openChannels, ['zulip:cc-hands']);
  assert.equal(z.openChannelsOnly, true);
  assert.equal(z.reconnect, true);
  assert.deepEqual(z.dmAllowlist, []);
  assert.equal(z.transport.env.ZULIP_RC_PATH, join(handDir, 'zuliprc'));
  assert.equal(z.transport.env.ZULIP_FILTERS_FILE, join(handDir, 'zulip-state', 'filters.json'));
  assert.deepEqual(JSON.parse(readFileSync(join(handDir, 'zulip-state', 'filters.json'), 'utf8')), { streams: ['cc-hands'] });
  assert.match(readFileSync(join(handDir, 'seed.md'), 'utf8'), /topic "release"/);

  const launched = JSON.parse(readFileSync(join(dir, `run-${e.sessionId}.json`), 'utf8'));
  assert.ok(launched.argv.includes('--session-id'));
  assert.deepEqual(launched.argv.slice(-3, -1), ['--effort', 'high']);
});

test('a busy name, a DM spawn and a hand driving the spawner are refused', async () => {
  assert.match((await run('spawn opus-5-5 name=scout')).content, /is taken/);
  assert.match((await run('spawn opus-5-5', { kind: 'dm', userIds: [1] })).content, /not from a DM/);
  const hand: Invoker = { userId: 100, name: 'Claude-Code-opus-5-5-scout', kind: 'resident' };
  assert.match((await run('list', home, hand)).content, /cannot drive/);
});

test('unauthorized users and streams are refused', async () => {
  assert.match((await run('list', home, { userId: 2, name: 'Outsider', kind: 'user' })).content, /Not authorized/);
  const elsewhere: Where = { kind: 'stream', streamName: 'general', streamId: 1, topic: 'x' };
  assert.match((await run('list', elsewhere)).content, /not allow-listed/);
});

test('list shows the hand; stop kills it and keeps the identity', async () => {
  assert.match((await run('list')).content, /Claude-Code-opus-5-5-scout.*#cc-hands > release/);
  const r = await run('stop scout');
  assert.match(r.content, /Stopped/);
  assert.equal(await tmux.hasSession('cc-opus-5-5-scout'), false);
  assert.equal(registry.findAlive('scout'), undefined);
});

test('revival resumes the same transcript, keeps effort, refuses another stream or model', async () => {
  const prior = registry.latestFor('Claude-Code-opus-5-5-scout')!;
  const t = transcriptPath(cfg.agentsHome, cfg.projectDir, prior.sessionId);
  mkdirSync(dirname(t), { recursive: true });
  writeFileSync(t, '{"type":"user"}\n');

  const elsewhere: Where = { kind: 'stream', streamName: 'cc-hands-2', streamId: 8, topic: 'x' };
  assert.match((await run('spawn opus-5-5 name=scout', { ...elsewhere, streamName: 'cc-hands' })).content, /home in #cc-hands/);
  assert.match((await run('spawn claude-opus-5-5-20261001 name=scout')).content, /ran on `claude-opus-5-5`/);

  const r = await run('spawn opus-5-5 name=scout', { ...home, topic: 'new topic' });
  assert.match(r.content, /Revived/);
  const e = registry.findAlive('scout')!;
  assert.equal(e.sessionId, prior.sessionId);
  assert.equal(e.effort, 'high');
  assert.equal(e.topic, 'new topic');
  assert.equal(e.botUserId, 100, 'same bot reused');
  assert.equal(e.transcriptOffset, statSync(t).size, 'history is not replayed by the watcher');
  const launched = JSON.parse(readFileSync(join(dir, `run-${e.sessionId}.json`), 'utf8'));
  assert.ok(launched.argv.includes('--resume'));
  assert.match(readFileSync(join(cfg.handsDir, 'cc-opus-5-5-scout', 'seed.md'), 'utf8'), /You're back/);
  await run('stop scout');
});

test('a failed spawn is recorded as failed and leaves no session', async () => {
  provisioner.failSubscribe = true;
  try {
    const r = await run('spawn sonnet-5-5 name=broken');
    assert.match(r.content, /failed: subscription refused.*kept/s);
    const e = registry.all().find((x) => x.suffix === 'broken')!;
    assert.equal(e.status, 'failed');
    assert.equal(await tmux.hasSession('cc-sonnet-5-5-broken'), false);
    assert.equal(registry.busy('broken'), undefined, 'a failed name is free for a retry');
  } finally {
    provisioner.failSubscribe = false;
  }
});

test('capacity counts alive and provisioning hands', async () => {
  const small = new SpawnerActions({
    config: { ...cfg, maxSessions: 0 },
    registry,
    host,
    tmux,
    provisioner: provisioner as unknown as Provisioner,
    launcher: new ClaudeLauncher(cfg, tmux),
    notifier,
    watcher,
    groupCheck: async () => false,
    realm: 'x',
  });
  const r = await small.run({ cmd: parseCommand('spawn opus-5-5'), body: '', where: home, invoker: tester });
  assert.match(r.content, /At capacity/);
});

test('peek is private and shows the terminal', async () => {
  await run('spawn opus-5-5 name=peeky');
  const r = await run('peek peeky');
  assert.equal(r.private, true);
  assert.match(r.content, /bypass permissions on/);
  await run('stop peeky');
});

test('activity from a hand updates lastActivity and firstPostAt', async () => {
  await run('spawn opus-5-5 name=talker');
  const e = registry.findAlive('talker')!;
  assert.equal(e.firstPostAt, undefined);
  assert.ok(actions.isHand(e.botUserId));
  actions.noteActivity(e.botUserId, 'message');
  assert.ok(registry.findAlive('talker')!.firstPostAt);
  await run('stop talker');
  assert.ok(!existsSync(join(dir, 'pwned')));
});
