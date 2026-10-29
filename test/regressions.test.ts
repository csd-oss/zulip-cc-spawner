/** Regression tests for the second review round (each names the failure it guards). */
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SpawnerActions } from '../src/actions.js';
import type { Invoker, Where } from '../src/auth.js';
import { parseCommand } from '../src/commands.js';
import type { SpawnerConfig } from '../src/config.js';
import { LocalHost, SudoHost, type AgentHost } from '../src/host.js';
import { ClaudeLauncher } from '../src/launcher.js';
import { splitContent, ZulipNotifier, type Notifier } from '../src/notifier.js';
import type { Provisioner } from '../src/provision.js';
import { Reaper } from '../src/reaper.js';
import { Registry, type BotEntry } from '../src/registry.js';
import { Tmux } from '../src/tmux.js';
import { TranscriptWatcher } from '../src/transcript-watch.js';
import type { ZulipClient } from '../src/zulip.js';
import { testConfig, tmp } from './helpers.js';

const home: Where = { kind: 'stream', streamName: 'cc-hands', streamId: 7, topic: 'release' };
const tester: Invoker = { userId: 1, name: 'Tester', kind: 'user' };

class Posts implements Notifier {
  out: string[] = [];
  failNext = 0;
  async postHome(_e: unknown, c: string) {
    if (this.failNext > 0) {
      this.failNext--;
      return undefined;
    }
    this.out.push(c);
    return this.out.length;
  }
  async reply(_w: Where, c: string) {
    this.out.push(c);
  }
  async dm() {}
}

const provisioner = {
  async ensure(_f: string, short: string) {
    return { bot: { userId: 100, email: `${short}-bot@example.org`, apiKey: 'k' }, created: true };
  },
  async subscribe() {},
  credsFor: () => ({ email: 'b@example.org', key: 'k', site: 'https://chat.example.org' }),
} as unknown as Provisioner;

function core(opts: { tmux: Tmux; launcher: ClaudeLauncher; host?: AgentHost; registry?: Registry; cfg?: Partial<SpawnerConfig> }) {
  const dir = tmp();
  const cfg = testConfig(dir, opts.cfg);
  const registry = opts.registry ?? new Registry(join(dir, 'r.json'));
  const host = opts.host ?? new LocalHost();
  const posts = new Posts();
  const watcher = new TranscriptWatcher(registry, host, opts.tmux, posts, { agentsHome: dir, projectDir: dir }, () => 'CC Spawner');
  const actions = new SpawnerActions({
    config: cfg, registry, host, tmux: opts.tmux, provisioner, launcher: opts.launcher, notifier: posts, watcher,
    groupCheck: async () => false, realm: 'https://chat.example.org',
  });
  const run = (text: string, invoker: Invoker = tester) => actions.run({ cmd: parseCommand(text), body: text, where: home, invoker });
  return { registry, posts, run, cfg };
}

test('a spawn whose cleanup kill fails stays occupied until the reaper confirms the kill', async () => {
  let killWorks = false;
  const tmux = {
    hasSession: async () => false,
    listSessions: async () => [],
    killSession: async () => {
      if (!killWorks) throw new Error('sudo: a password is required');
    },
  } as unknown as Tmux;
  const launcher = { launch: async () => { throw new Error('claude exited during startup'); } } as unknown as ClaudeLauncher;
  const c = core({ tmux, launcher });
  const r = await c.run('spawn opus-5-5 name=stuck');
  assert.match(r.content, /could not be confirmed stopped/);
  const e = c.registry.all()[0];
  assert.equal(e.status, 'cleanup');
  assert.ok(c.registry.busy('stuck'), 'the name stays taken');
  assert.equal(c.registry.occupied().length, 1, 'and it counts toward capacity');
  assert.match((await c.run('spawn opus-5-5 name=stuck')).content, /is taken/);

  const reaper = new Reaper(c.registry, tmux, c.posts, { inactivityMs: 1 }, async () => undefined);
  await reaper.sweep();
  assert.equal(c.registry.all()[0].status, 'cleanup', 'still failing ⇒ still cleanup');
  killWorks = true;
  await reaper.sweep();
  assert.equal(c.registry.all()[0].status, 'failed');
});

test('revival refuses to start fresh when the transcript check itself fails', async () => {
  const dir = tmp();
  const registry = new Registry(join(dir, 'r.json'));
  registry.add({
    suffix: 'old', personaName: 'Claude-Code-opus-5-5-old', botUserId: 100, botEmail: 'b@example.org', tmuxSession: 'cc-opus-5-5-old',
    streamName: 'cc-hands', streamId: 7, topic: 'release', handDir: '/x', model: 'claude-opus-5-5', sessionId: 'prior',
    spawnedBy: { userId: 1, username: 'Tester' }, spawnedAt: '2026-01-01T00:00:00Z', lastActivity: '2026-01-01T00:00:00Z',
    status: 'reaped', seedFile: '/x/seed',
  } satisfies BotEntry);
  const host = new LocalHost();
  host.exists = async () => {
    throw new Error('sudo: a password is required');
  };
  let launched = false;
  const launcher = { launch: async () => { launched = true; return {}; } } as unknown as ClaudeLauncher;
  const tmux = { hasSession: async () => false, listSessions: async () => [] } as unknown as Tmux;
  const c = core({ tmux, launcher, host, registry });
  const r = await c.run('spawn opus-5-5 name=old');
  assert.match(r.content, /Could not check .* nothing was started/);
  assert.equal(launched, false);
});

test('SudoHost: a refused sudo is an error, never "missing"', async () => {
  const dir = tmp('ccsudo-');
  writeFileSync(join(dir, 'sudo'), '#!/bin/sh\necho "sudo: a password is required" >&2\nexit 1\n');
  chmodSync(join(dir, 'sudo'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    const h = new SudoHost('cc-agents');
    await assert.rejects(h.exists('/etc/hosts'), /password is required/);
    await assert.rejects(h.size('/etc/hosts'), /password is required/);
  } finally {
    process.env.PATH = oldPath;
  }
});

test('a missing env file stops the launch instead of running claude without it', async () => {
  const dir = tmp();
  const cfg = testConfig(dir, { agentsEnvFile: join(dir, 'does-not-exist.env') });
  const tmux = new Tmux(new LocalHost(), cfg.tmuxSocket);
  const seed = join(dir, 'seed.md');
  writeFileSync(seed, 'hi');
  await assert.rejects(
    new ClaudeLauncher(cfg, tmux).launch({
      personaName: 'p', model: 'claude-opus-5-5', sessionId: 'nope', resume: false, tmuxSession: 'cc-noenv',
      bridgeConfig: join(dir, 'b.json'), seedFile: seed, spawnedBy: 'x', streamName: 's', topic: 't',
    }),
    /exited during startup/,
  );
});

test('a missing seed file stops the launch', async () => {
  const dir = tmp();
  const cfg = testConfig(dir);
  const tmux = new Tmux(new LocalHost(), cfg.tmuxSocket);
  await assert.rejects(
    new ClaudeLauncher(cfg, tmux).launch({
      personaName: 'p', model: 'claude-opus-5-5', sessionId: 'nope2', resume: false, tmuxSession: 'cc-noseed',
      bridgeConfig: join(dir, 'b.json'), seedFile: join(dir, 'missing.md'), spawnedBy: 'x', streamName: 's', topic: 't',
    }),
    /exited during startup/,
  );
});

const PERMISSION_PANE = [
  '──────────────────────────────', ' Bash command', '   │ make deploy', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Tab to amend',
].join('\n');

test('a dialog post that failed is retried on the next sweep', async () => {
  const pane = { text: PERMISSION_PANE, fail: false };
  const tmux = {
    capturePane: async () => {
      if (pane.fail) throw new Error('sudo: a password is required');
      return pane.text;
    },
    sendKeys: async () => {},
  } as unknown as Tmux;
  const dir = tmp();
  const registry = new Registry(join(dir, 'r.json'));
  registry.add({
    suffix: 'scout', personaName: 'Claude-Code-opus-5-5-scout', botUserId: 100, botEmail: 'b@example.org', tmuxSession: 'cc-x',
    streamName: 'cc-hands', streamId: 7, topic: 'release', handDir: '/x', model: 'claude-opus-5-5', sessionId: 's',
    spawnedBy: { userId: 1, username: 'Tester' }, spawnedAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
    status: 'alive', seedFile: '/x/seed', transcriptOffset: 0,
  });
  const posts = new Posts();
  posts.failNext = 1;
  const w = new TranscriptWatcher(registry, new LocalHost(), tmux, posts, { agentsHome: dir, projectDir: dir }, () => 'CC Spawner');
  await w.sweep();
  assert.equal(posts.out.length, 0);
  assert.equal(registry.all()[0].pendingQuestion?.messageId, undefined);
  await w.sweep();
  assert.equal(posts.out.length, 1);
  assert.equal(registry.all()[0].pendingQuestion?.messageId, '1');
  await w.sweep();
  assert.equal(posts.out.length, 1, 'posted once it succeeded — no repeats');

  // An unreadable screen during rescan must not "resolve" the prompt.
  pane.fail = true;
  const lines = await w.rescanDialogs();
  assert.match(lines[0], /could not read its screen/);
  assert.ok(registry.all()[0].pendingQuestion, 'still pending');
});

test('notifier: long content is split on lines; failures are swallowed', async () => {
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i} `.padEnd(60, 'x'));
  const chunks = splitContent(lines.join('\n'), 5000);
  assert.ok(chunks.length > 1 && chunks.every((c) => c.length <= 5000));
  assert.equal(chunks.join('\n'), lines.join('\n'));
  assert.deepEqual(splitContent(''), ['(empty)']);
  assert.ok(splitContent('y'.repeat(12000), 5000).every((c) => c.length <= 5000));

  const sent: string[] = [];
  const client = {
    sendStream: async (_s: string, _t: string, c: string) => {
      sent.push(c);
      return sent.length;
    },
    sendDm: async () => {
      throw new Error('DMs disabled');
    },
  } as unknown as ZulipClient;
  const n = new ZulipNotifier(client);
  assert.equal(await n.postHome({ streamName: 'cc-hands', topic: 't' }, lines.join('\n')), 1);
  assert.ok(sent.length >= 2);
  await n.dm([1], 'hello'); // must not throw
  await n.reply({ kind: 'dm', userIds: [1] }, 'hello');
});

test('with allowedResidents "*", any bot may drive the spawner, but never one of its own hands', async () => {
  const dir = tmp();
  const registry = new Registry(join(dir, 'r.json'));
  registry.add({
    suffix: 'scout', personaName: 'Claude-Code-opus-5-5-scout', botUserId: 100, botEmail: 'b@example.org', tmuxSession: 'cc-x',
    streamName: 'cc-hands', streamId: 7, topic: 'release', handDir: '/x', model: 'claude-opus-5-5', sessionId: 's',
    spawnedBy: { userId: 1, username: 'Tester' }, spawnedAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
    status: 'alive', seedFile: '/x/seed',
  });
  const tmux = { hasSession: async () => true, listSessions: async () => ['cc-x'] } as unknown as Tmux;
  const launcher = {} as unknown as ClaudeLauncher;
  const c = core({ tmux, launcher, registry, cfg: { allowedResidents: ['*'] } });
  const otherBot: Invoker = { userId: 777, name: 'Helper Bot', kind: 'resident' };
  const ownHand: Invoker = { userId: 100, name: 'Claude-Code-opus-5-5-scout', kind: 'resident' };
  assert.match((await c.run('list', otherBot)).content, /scout/);
  assert.match((await c.run('list', ownHand)).content, /Spawned hands cannot drive the spawner/);
});
