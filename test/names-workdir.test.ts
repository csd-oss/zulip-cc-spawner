import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, openSync, readSync, closeSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { SpawnerActions } from '../src/actions.js';
import { parseCommand } from '../src/commands.js';
import { LocalHost } from '../src/host.js';
import { ClaudeLauncher, type LaunchRequest } from '../src/launcher.js';
import { handName } from '../src/names.js';
import type { Notifier } from '../src/notifier.js';
import { Provisioner } from '../src/provision.js';
import { Registry } from '../src/registry.js';
import type { Tmux } from '../src/tmux.js';
import { TranscriptWatcher } from '../src/transcript-watch.js';
import { prepareWorkDir } from '../src/workdir.js';
import { testConfig, tmp } from './helpers.js';

function fixture() {
  const dir = tmp();
  const cfg = testConfig(dir);
  const host = new LocalHost();
  const registry = new Registry(join(dir, 'registry.json'));
  const sessions = new Set<string>();
  const launches: LaunchRequest[] = [];
  const cwds: string[] = [];
  const tmux = {
    hasSession: async (s: string) => sessions.has(s), listSessions: async () => [...sessions],
    killSession: async (s: string) => { sessions.delete(s); },
    capturePane: async () => '? for shortcuts', sessionUptime: async () => 1,
    newSession: async (s: string, cwd: string) => { cwds.push(cwd); sessions.add(s); },
  } as unknown as Tmux;
  const launcher = new ClaudeLauncher(cfg, tmux);
  const launch = launcher.launch.bind(launcher);
  launcher.launch = async r => { launches.push(r); return launch(r); };
  const notifier = { postHome: async () => 1, reply: async () => {}, dm: async () => {} } as Notifier;
  const watcher = new TranscriptWatcher(registry, host, tmux, notifier, cfg, () => 'spawner');
  const provisioner = {
    ensure: async (_full: string, short: string) => ({ bot: { userId: 100, email: `${short}-bot@x`, apiKey: 'fake' }, created: true }),
    subscribe: async () => {}, credsFor: () => ({ email: 'fake@x', key: 'fake', site: 'https://x' }),
  } as unknown as Provisioner;
  const actions = new SpawnerActions({ config: cfg, registry, host, tmux, launcher, notifier, watcher, provisioner, groupCheck: async () => false, realm: 'x' });
  const run = (body: string) => actions.run({ body, cmd: parseCommand(body), where: { kind: 'stream', streamName: 'cc-hands', streamId: 7, topic: 't' }, invoker: { userId: 1, name: 'Tester', kind: 'user' } });
  return { dir, cfg, host, registry, watcher, run, launches, cwds };
}

test('display harness label, ASCII identity and bounded names', () => {
  assert.deepEqual(handName('claude-opus', 'Syncntn'), { personaName: '[cc-opus] Syncntn', shortName: 'cc-syncntn' });
  assert.equal(handName('astra-6', 'hand', 'cx').personaName, '[cx-astra-6] hand');
  const n = handName('a'.repeat(80), 'X'.repeat(24));
  assert.ok(n.personaName.length <= 49);
  assert.equal(n.shortName.length, 27);
  assert.equal(`${n.shortName}-bot`.length, 31);
  assert.match(n.shortName, /^[a-z0-9-]+$/);
  assert.throws(() => handName('opus', '../bad'));
  assert.throws(() => handName('opus', 'x'.repeat(25)));
});

test('both styles parse and look up for stop, peek and answer', async () => {
  const c = fixture();
  await c.run('spawn opus-5-5 name=Scout');
  const e = c.registry.all()[0];
  for (const target of [e.personaName, e.tmuxSession, e.suffix]) {
    assert.equal(c.registry.findAlive(target), e);
    assert.deepEqual(parseCommand(`stop ${target}`), { kind: 'stop', target });
    assert.deepEqual(parseCommand(`peek ${target} 10`), { kind: 'peek', target, lines: 10 });
    assert.deepEqual(parseCommand(`answer ${target} text: a  b`), { kind: 'answer', target, spec: 'text: a  b' });
  }
  assert.match((await c.run(`peek ${e.personaName}`)).content, /Scout/);
  assert.match((await c.run(`answer ${e.personaName} yes`)).content, /no pending/);
  assert.match((await c.run(`stop ${e.personaName}`)).content, /Stopped/);
});

test('new spawn is empty, private, trusted; revive retains cwd and transcript', async () => {
  const c = fixture();
  assert.match((await c.run('spawn opus-5-5 name=Scout')).content, /Spawned/);
  const e = c.registry.all()[0];
  assert.equal(e.workDir, join(c.cfg.projectDir, 'hands', e.tmuxSession));
  assert.deepEqual(readdirSync(e.workDir!), []);
  assert.equal(statSync(e.workDir!).mode & 0o777, 0o700);
  assert.equal(statSync(e.workDir!).uid, process.getuid!());
  assert.equal(JSON.parse(readFileSync(join(c.cfg.agentsHome, '.claude.json'), 'utf8')).projects[e.workDir!].hasTrustDialogAccepted, true);
  const transcript = c.watcher.transcriptPath(e.sessionId, e.workDir);
  mkdirSync(dirname(transcript), { recursive: true }); writeFileSync(transcript, '{}\n');
  await c.run('stop scout');
  await c.run('spawn opus-5-5 name=scout');
  assert.equal(c.launches[1].resume, true);
  assert.equal(c.launches[1].sessionId, e.sessionId);
  assert.deepEqual(c.cwds, [e.workDir, e.workDir]);
  assert.deepEqual(readdirSync(e.workDir!), []);
});

test('legacy registry round-trip and revival preserve identity, arbitrary handDir and old cwd', async () => {
  const c = fixture();
  await c.run('spawn opus-5-5 name=old');
  const e = c.registry.all()[0];
  await c.run('stop old');
  delete e.workDir; delete e.nameScheme; delete e.harness;
  e.personaName = 'Claude-Code-opus-5-5-old';
  e.handDir = join(c.dir, 'original-hand');
  c.registry.save();
  const loaded = new Registry(join(c.dir, 'registry.json')); loaded.load();
  assert.deepEqual(loaded.all(), JSON.parse(JSON.stringify(c.registry.all())));
  const path = c.watcher.transcriptPath(e.sessionId);
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '{}\n');
  assert.match((await c.run('spawn opus-5-5 name=old')).content, /Revived.*Claude-Code/);
  const revived = c.registry.all()[1];
  assert.equal(revived.handDir, e.handDir);
  assert.equal(revived.personaName, e.personaName);
  assert.equal(revived.botEmail, e.botEmail);
  assert.equal(revived.tmuxSession, e.tmuxSession);
  assert.equal(c.cwds[1], c.cfg.projectDir);
  assert.equal(c.launches[1].resume, true);
  assert.equal(c.launches[1].sessionId, e.sessionId);
  assert.equal(c.registry.findAlive(e.personaName), revived);
});

test('unmarked bracket persona cannot be hijacked', async () => {
  const c = fixture();
  await c.run('spawn opus-5-5 name=old'); await c.run('stop old');
  const e = c.registry.all()[0];
  delete e.nameScheme;
  assert.match((await c.run('spawn opus-5-5 name=old')).content, /collision/);
  assert.equal(c.launches.length, 1);
});

test('trust merge serializes concurrent processes and replaces atomically, preserving keys', async () => {
  const c = fixture();
  mkdirSync(c.cfg.agentsHome);
  const file = join(c.cfg.agentsHome, '.claude.json');
  const original = JSON.stringify({ other: { keep: 1 }, projects: { '/old': { keep: 2 } } });
  writeFileSync(file, original);
  const fd = openSync(file, 'r');
  try {
    await Promise.all(Array.from({ length: 8 }, (_, i) => prepareWorkDir(c.host, c.cfg, join(c.dir, `work-${i}`), true)));
    const buf = Buffer.alloc(original.length); readSync(fd, buf, 0, buf.length, 0);
    assert.equal(buf.toString(), original, 'old open inode was not modified in place');
  } finally { closeSync(fd); }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(data.other, { keep: 1 }); assert.deepEqual(data.projects['/old'], { keep: 2 });
  assert.equal(Object.keys(data.projects).length, 9);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  data.projects[join(c.dir, 'work-0')].extra = true; writeFileSync(file, JSON.stringify(data));
  await prepareWorkDir(c.host, c.cfg, join(c.dir, 'work-0'), false);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).projects[join(c.dir, 'work-0')].extra, true);
  writeFileSync(file, 'broken');
  await assert.rejects(prepareWorkDir(c.host, c.cfg, join(c.dir, 'work-0'), false));
  assert.equal(readFileSync(file, 'utf8'), 'broken');
});


test('configurable workRoot and watcher use the recorded cwd', async () => {
  const c = fixture();
  c.cfg.workRoot = join(c.dir, 'custom');
  await c.run('spawn opus-5-5');
  const e = c.registry.all()[0];
  assert.match(e.suffix, /^[a-f0-9]{4}$/);
  assert.equal(e.workDir, join(c.cfg.workRoot, e.tmuxSession));
  const path = c.watcher.transcriptPath(e.sessionId, e.workDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ message: { model: 'test-model' } }) + '\n');
  await c.watcher.sweep();
  assert.equal(e.lastModel, 'test-model');
  const reload = new Registry(join(c.dir, 'registry.json')); reload.load();
  assert.equal(reload.all()[0].workDir, e.workDir);
});

test('new identity never adopts an existing workspace or unregistered legacy bot', async () => {
  const c = fixture();
  const path = join(c.cfg.projectDir, 'hands', 'cc-old');
  mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'keep'), 'keep');
  assert.match((await c.run('spawn opus-5-5 name=old')).content, /failed/);
  assert.equal(c.launches.length, 0);
  assert.match((await c.run('spawn opus-5-5 name=old')).content, /failed/);
  assert.equal(c.launches.length, 0, 'retry must not adopt the pre-existing directory either');
  assert.equal(readFileSync(join(path, 'keep'), 'utf8'), 'keep');
  let creates = 0;
  const api = {
    ownedBots: async () => [{ username: 'cc-opus-5-5-old-bot@x', api_key: 'fake' }],
    user: async () => ({ user: { user_id: 1, email: 'cc-opus-5-5-old-bot@x', full_name: 'Claude-Code-opus-5-5-old' } }),
    createBot: async () => { creates++; },
  };
  const p = new Provisioner(api as unknown as ConstructorParameters<typeof Provisioner>[0]);
  await assert.rejects(p.ensure('[cc-opus-5-5] old', 'cc-opus-5-5-old', true), /collision/);
  assert.equal(creates, 0);
  assert.equal((await p.ensure('Claude-Code-opus-5-5-old', 'cc-opus-5-5-old')).created, false);
});


test('first trust failure stays fail-closed after JSON repair; manual empty-dir recovery permits retry', async () => {
  const c = fixture();
  mkdirSync(c.cfg.agentsHome);
  const file = join(c.cfg.agentsHome, '.claude.json');
  writeFileSync(file, 'broken');
  assert.match((await c.run('spawn opus-5-5 name=retry')).content, /failed/);
  const first = c.registry.all()[0];
  const workDir = first.workDir!;
  assert.equal(first.status, 'failed');
  assert.equal(first.workDirReady, undefined);
  assert.deepEqual(readdirSync(workDir), []);
  assert.equal(c.launches.length, 0);

  writeFileSync(file, '{}'); // isolated test config; real operators preserve keys
  const retry = await c.run('spawn opus-5-5 name=retry');
  assert.match(retry.content, /Workspace already exists:/);
  assert.ok(retry.content.includes(workDir), 'action reply names the exact workspace');
  assert.match(retry.content, /Refusing to adopt it/);
  assert.equal(c.launches.length, 0);
  assert.deepEqual(readdirSync(workDir), []);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {});

  rmdirSync(workDir); // documented manual recovery, refuses nonempty directories
  assert.match((await c.run('spawn opus-5-5 name=retry')).content, /Spawned/);
  const recovered = c.registry.findAlive('retry')!;
  assert.equal(recovered.workDir, workDir);
  assert.equal(recovered.botEmail, first.botEmail);
  assert.equal(recovered.workDirReady, true);
  assert.equal(c.launches.length, 1);
  assert.deepEqual(readdirSync(workDir), []);
});
