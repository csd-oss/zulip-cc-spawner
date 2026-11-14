import { managerSnapshot } from './manager-fixture.js';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, statSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as pathModule from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { SpawnerActions, type ActionDeps } from '../src/actions.js';
import type { Where } from '../src/auth.js';
import { parseCommand } from '../src/commands.js';
import { DELETE_PATHS_JS, HAND_PROCESSES_JS, handStopped } from '../src/delete-hand.js';
import { LocalHost, type AgentHost } from '../src/host.js';
import { Registry, type BotEntry } from '../src/registry.js';
import { Tmux } from '../src/tmux.js';
import { testConfig, tmp } from './helpers.js';

const home: Where = { kind: 'stream', streamName: 'cc-hands', streamId: 7, topic: 'invocation' };
function fixture(overrides: Parameters<typeof testConfig>[1] = {}) {
  const dir = tmp();
  const config = testConfig(dir, { allowedUsers: [1, 2, 9], allowedStreams: ['*'], ownerUserId: 9, ...overrides });
  mkdirSync(config.handsDir, { recursive: true });
  const workRoot = config.workRoot ?? join(config.projectDir, 'hands');
  mkdirSync(workRoot, { recursive: true });
  const registryFile = join(dir, 'registry.json');
  const registry = new Registry(registryFile);
  const state = { tmux: false, process: false, failTmux: false, failProcess: false, failBot: false, failRemove: false };
  const deactivated: number[] = [];
  const tmux = { async otherPaneRoots() { return []; }, async hasSession() { if (state.failTmux) throw Error('unavailable'); return state.tmux; } } as Tmux;
  const local = new LocalHost();
  const host = {
    exec: async (cmd: string, args: string[]) => {
      if (args[1] === HAND_PROCESSES_JS) {
        if (state.failProcess) throw Error('unavailable');
        return { stdout: JSON.stringify(state.process) };
      }
      if (state.failRemove && JSON.parse(args[2])[1]) throw Error('filesystem unavailable');
      return local.exec(cmd, args);
    },
  } as AgentHost;
  const provisioner = { async deactivate(id: number) { deactivated.push(id); if (state.failBot) throw Error('offline failure'); } };
  const actions = new SpawnerActions({ config, registry, host, tmux, provisioner,
    groupCheck: async () => false } as unknown as ActionDeps);
  const run = (body: string, userId = 1, where = home) => actions.run({ body, cmd: parseCommand(body), where,
    invoker: { kind: 'user', userId, name: `User ${userId}` } });
  function add(patch: Partial<BotEntry> = {}) {
    const entry: BotEntry = {
      suffix: 'scout', friendlyName: 'Pathfinder', nameAliases: ['old-name'], personaName: '[cc-opus-5-5] Pathfinder',
      botUserId: 42, botEmail: 'scout-bot@offline', botCreatedBySpawner: true, tmuxSession: 'cc-scout',
      handDir: join(config.handsDir, 'cc-scout'), workDir: join(workRoot, 'cc-scout'),
      streamName: 'cc-hands', streamId: 7, topic: 'home topic', model: 'claude-opus-5-5',
      sessionId: 'session-id', spawnedBy: { userId: 1, username: 'Creator' },
      spawnedAt: '2026-11-10T00:00:00Z', lastActivity: '2026-11-11T01:02:03Z',
      status: 'reaped', seedFile: 'unused', workDirReady: true, handDirReady: true, ...patch,
    };
    for (const path of [entry.handDir, entry.workDir].filter((x): x is string => Boolean(x))) {
      mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'keep'), 'contents');
    }
    for (const kind of ['handDir', 'workDir'] as const) {
      const dir = entry[kind];
      if (dir && entry[kind === 'handDir' ? 'handDirReady' : 'workDirReady']) {
        const { dev, ino } = lstatSync(dir);
        const marker = join(dir, '.cc-spawner-owner');
        const nonce = existsSync(marker) ? readFileSync(marker, 'utf8') : randomBytes(32).toString('hex');
        writeFileSync(marker, nonce);
        entry[kind === 'handDir' ? 'handDirIdentity' : 'workDirIdentity'] = { dev, ino, nonce };
      }
    }
    registry.add(entry);
    return entry;
  }
  function unchanged(entry: BotEntry, before: string) {
    assert.equal(readFileSync(registryFile, 'utf8'), before);
    assert.equal(readFileSync(join(entry.handDir, 'keep'), 'utf8'), 'contents');
    assert.equal(readFileSync(join(entry.workDir!, 'keep'), 'utf8'), 'contents');
    assert.deepEqual(deactivated, []);
  }
  return { dir, config, registry, registryFile, state, deactivated, host, tmux, add, run, unchanged };
}

for (const strict of [false, true]) for (const user of [1, 9]) test(`delete: ${user === 1 ? 'creator' : 'owner'} allowed with creatorOnlyControls=${strict}`, async () => {
  const f = fixture({ creatorOnlyControls: strict }); const e = f.add();
  const result = await f.run('delete scout confirm', user);
  assert.match(result.content, /Deleted/); assert.equal(result.private, undefined);
  assert.equal(existsSync(e.handDir), false); assert.equal(existsSync(e.workDir!), false);
  assert.equal(f.registry.all().length, 0); assert.deepEqual(f.deactivated, [42]);
  const persisted = new Registry(f.registryFile); persisted.load(); assert.deepEqual(persisted.all(), []);
});

for (const strict of [false, true]) for (const confirm of ['', ' confirm']) test(`delete: other allowed caller refused, strict=${strict}, confirm=${Boolean(confirm)}`, async () => {
  const f = fixture({ creatorOnlyControls: strict }); const e = f.add(); const before = readFileSync(f.registryFile, 'utf8');
  assert.match((await f.run('delete scout' + confirm, 2)).content, /Only this hand's creator.*regardless of creatorOnlyControls/);
  f.unchanged(e, before);
});

test('delete: legacy creator unknown requires configured owner; strict-mode adopted-hand exception does not apply', async () => {
  const f = fixture({ creatorOnlyControls: true }); const e = f.add({ spawnedBy: undefined });
  const before = readFileSync(f.registryFile, 'utf8');
  assert.match((await f.run('delete scout confirm')).content, /creator.*unknown/); f.unchanged(e, before);
  assert.match((await f.run('delete scout confirm', 9)).content, /Deleted/);
  const g = fixture({ ownerUserId: undefined, creatorOnlyControls: false }); const old = g.add({ spawnedBy: undefined });
  const oldBefore = readFileSync(g.registryFile, 'utf8');
  assert.match((await g.run('delete scout confirm')).content, /creator unknown and no ownerUserId configured/); g.unchanged(old, oldBefore);
});

test('delete: creator can delete with no owner configured', async () => {
  const f = fixture({ ownerUserId: undefined }); f.add(); assert.match((await f.run('delete scout confirm')).content, /Deleted/);
});

for (const target of ['scout', 'old-name', 'Pathfinder', '[cc-opus-5-5] Pathfinder', '@**[cc-opus-5-5] Pathfinder**', 'cc-scout', 'scout-bot@offline']) test(`delete dry-run resolves ${target} and changes nothing`, async () => {
  const f = fixture(); const e = f.add(); const before = readFileSync(f.registryFile, 'utf8');
  const result = await f.run(`delete ${target}`);
  assert.match(result.content, /Dry-run/); assert.match(result.content, /all 1 entry\/entries/);
  assert.ok(result.content.includes(e.handDir)); assert.ok(result.content.includes(e.workDir!));
  assert.match(result.content, /Bot deactivation: user 42/); assert.match(result.content, /Nothing changed/);
  assert.equal(result.private, undefined); f.unchanged(e, before);
});

for (const cause of ['alive', 'provisioning', 'cleanup', 'tmux', 'process'] as const) test(`delete: refuses ${cause} even when other liveness checks say stopped`, async () => {
  const f = fixture(); const e = f.add(['alive', 'provisioning', 'cleanup'].includes(cause) ? { status: cause as BotEntry['status'] } : {});
  if (cause === 'tmux' || cause === 'process') f.state[cause] = true;
  const before = readFileSync(f.registryFile, 'utf8');
  for (const suffix of ['', ' confirm']) assert.match((await f.run('delete scout' + suffix)).content, /must be STOPPED/);
  f.unchanged(e, before);
});

for (const cause of ['failTmux', 'failProcess'] as const) test(`delete: ${cause} fails closed`, async () => {
  const f = fixture(); const e = f.add(); f.state[cause] = true; const before = readFileSync(f.registryFile, 'utf8');
  assert.match((await f.run('delete scout confirm')).content, /Could not complete deletion/); f.unchanged(e, before);
});

for (const kind of ['handDir', 'workDir'] as const) for (const attack of ['escape', 'dotdot', 'root', 'prefix', 'symlink', 'parent-symlink', 'internal-symlink']) test(`delete path safety: ${kind} ${attack}`, async () => {
  const f = fixture(); const e = f.add();
  const original = e[kind]!; const root = kind === 'handDir' ? f.config.handsDir : join(f.dir, 'hands');
  const outside = join(f.dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'sentinel'), 'untouched');
  let unsafe = original;
  if (attack === 'escape') unsafe = outside;
  if (attack === 'dotdot') unsafe = root + '/nested/../cc-scout';
  if (attack === 'root') unsafe = root;
  if (attack === 'prefix') { unsafe = root + '-other'; mkdirSync(unsafe); }
  if (attack === 'symlink') { rmSync(original, { recursive: true }); symlinkSync(outside, original); }
  if (attack === 'parent-symlink') { const link = join(root, 'link'); symlinkSync(outside, link); unsafe = join(link, 'child'); mkdirSync(join(outside, 'child')); }
  if (attack === 'internal-symlink') symlinkSync(outside, join(original, 'link'));
  f.registry.update(e, { [kind]: unsafe }); const before = readFileSync(f.registryFile, 'utf8');
  for (const confirm of ['', ' confirm']) assert.match((await f.run('delete scout' + confirm)).content, /Cannot delete:/);
  assert.equal(readFileSync(f.registryFile, 'utf8'), before); assert.deepEqual(f.deactivated, []);
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'untouched');
  assert.ok(existsSync(kind === 'handDir' ? e.workDir! : e.handDir), 'other directory is not removed before full validation');
});

test('delete: full historical cleanup, unique bots, unrelated hand kept, idempotent', async () => {
  const f = fixture(); const first = f.add();
  const second = f.add({ handDir: join(f.config.handsDir, 'old-files'), workDir: join(f.dir, 'hands', 'old-work'), botCreatedBySpawner: false });
  const other = f.add({ suffix: 'other', friendlyName: 'Other', nameAliases: [], personaName: '[cc-opus-5-5] Other', tmuxSession: 'cc-other', botUserId: 43,
    handDir: join(f.config.handsDir, 'cc-other'), workDir: join(f.dir, 'hands', 'cc-other') });
  assert.match((await f.run('delete scout')).content, /all 2 entry\/entries/);
  assert.match((await f.run('delete scout confirm')).content, /Deleted/);
  for (const e of [first, second]) { assert.equal(existsSync(e.handDir), false); assert.equal(existsSync(e.workDir!), false); }
  assert.deepEqual(f.registry.all(), [other]); assert.ok(existsSync(other.handDir)); assert.deepEqual(f.deactivated, [42]);
  for (const body of ['delete scout', 'delete scout confirm']) assert.match((await f.run(body)).content, /not found/);
  assert.deepEqual(f.deactivated, [42]);
});

for (const provenance of [undefined, false]) test(`delete: bot without positive provenance (${provenance}) kept`, async () => {
  const f = fixture(); f.add({ botCreatedBySpawner: provenance });
  assert.match((await f.run('delete scout confirm')).content, /no recorded spawner-created bot; existing bot kept/);
  assert.deepEqual(f.deactivated, []);
});

test('delete: bot deactivation failure still finishes local cleanup and warns', async () => {
  const f = fixture(); const e = f.add(); f.state.failBot = true;
  const result = await f.run('delete scout confirm');
  assert.match(result.content, /deactivation failed; local cleanup still completed/);
  assert.equal(existsSync(e.handDir), false); assert.equal(existsSync(e.workDir!), false); assert.deepEqual(f.registry.all(), []);
  assert.match((await f.run('delete scout confirm')).content, /not found/);
});

test('delete: filesystem failure preserves registry and bot for retry', async () => {
  const f = fixture(); const e = f.add(); f.state.failRemove = true; const before = readFileSync(f.registryFile, 'utf8');
  assert.match((await f.run('delete scout confirm')).content, /Registry kept for retry/); f.unchanged(e, before);
});

test('delete: missing directories can be retried; unrecorded legacy projectDir is never removed', async () => {
  const f = fixture(); const e = f.add({ workDir: undefined }); rmSync(e.handDir, { recursive: true });
  assert.match((await f.run('delete scout')).content, /already absent.*\n.*legacy projectDir is kept/s);
  assert.match((await f.run('delete scout confirm')).content, /Deleted/); assert.ok(existsSync(f.config.projectDir));
});

test('delete: ambiguous names, wrong mention id and normal authorization refuse', async () => {
  const f = fixture(); const e = f.add(); f.add({ tmuxSession: 'different' });
  assert.match((await f.run('delete scout confirm')).content, /Ambiguous/);
  assert.match((await f.run('delete @**Pathfinder|999** confirm')).content, /not found/);
  assert.match((await f.run('delete cc-scout confirm', 77)).content, /Not authorized/); assert.ok(existsSync(e.handDir));
});

test('delete: shared paths and shared bots are refused', async () => {
  const f = fixture(); const e = f.add(); const other = f.add({ suffix: 'other', friendlyName: 'Other', nameAliases: [], personaName: 'Other', tmuxSession: 'other', botUserId: 43 });
  assert.match((await f.run('delete cc-scout confirm')).content, /directory is shared/);
  f.registry.update(other, { handDir: join(f.config.handsDir, 'other'), workDir: join(f.config.workRoot ?? join(f.config.projectDir, 'hands'), 'other'), botUserId: 42 });
  assert.match((await f.run('delete cc-scout confirm')).content, /bot is shared/); assert.ok(existsSync(e.handDir));
});

test('registry removal atomic-write failure restores in-memory entries', () => {
  const f = fixture(); const e = f.add();
  renameSync(f.registryFile, f.registryFile + '.saved'); mkdirSync(f.registryFile);
  assert.throws(() => f.registry.removeHand(e.tmuxSession)); assert.deepEqual(f.registry.all(), [e]);
  assert.deepEqual(JSON.parse(readFileSync(f.registryFile + '.saved', 'utf8')), [e]);
});

test('list stopped: latest identity once, creator/name/home/activity; list unchanged and replies here or in invoking DM', async () => {
  const f = fixture(); f.add(); f.add({ lastActivity: '2026-11-12T01:02:03Z' });
  f.add({ tmuxSession: 'cc-live', suffix: 'live', personaName: 'Live', status: 'alive' });
  let result = await f.run('list stopped');
  assert.match(result.content, /1 stopped hand/); assert.match(result.content, /\[cc-opus-5-5\] Pathfinder.*Pathfinder.*Creator.*#cc-hands > home topic.*2026-11-12T01:02:03Z/);
  assert.equal(result.content.includes('Live'), false); assert.equal(result.private, undefined);
  result = await f.run('list'); assert.match(result.content, /Live/); assert.equal(result.content.includes('Pathfinder'), false);
  result = await f.run('list stopped', 1, { kind: 'dm', userIds: [1] }); assert.equal(result.private, undefined); assert.match(result.content, /1 stopped hand/);
});

test('list stopped: absent creator/activity, id fallback, no stopped hands and failed liveness', async () => {
  const f = fixture(); assert.equal((await f.run('list stopped')).content, 'No stopped hands.');
  f.add({ spawnedBy: undefined, lastActivity: undefined as unknown as string });
  assert.match((await f.run('list stopped')).content, /creator: unknown, home/);
  assert.equal((await f.run('list stopped')).content.includes('last activity'), false);
  f.registry.update(f.registry.all()[0], { spawnedBy: { userId: 123, username: '' } });
  assert.match((await f.run('list stopped')).content, /creator: 123/);
  f.state.process = true; assert.equal((await f.run('list stopped')).content, 'No stopped hands.');
  f.state.process = false; f.state.failProcess = true; assert.match((await f.run('list stopped')).content, /Could not verify stopped/);
});

for (const marker of ['cwd', 'environment', 'session'] as const) test(`real process check refuses a detached process identified by ${marker}`, async () => {
  const f = fixture(); const e = f.add({ sessionId: 'unique-detached-hand-session' });
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)", ...(marker === 'session' ? [e.sessionId] : [])], {
    cwd: marker === 'cwd' ? e.workDir : f.dir,
    env: { ...process.env, ...(marker === 'environment' ? { MCPL_BRIDGE_CONFIG: join(e.handDir, 'mcpl-bridge.json') } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await once(child.stdout!, 'data');
    assert.equal(await handStopped(new LocalHost(), f.tmux, f.config, [e]), false);
  } finally { child.kill(); await once(child, 'exit'); }
});

test('delete: custom workRoot is honored, not the default project/hands directory', async () => {
  const workRoot = tmp('ccsp-work-'); const f = fixture({ workRoot }); const e = f.add();
  assert.match((await f.run('delete scout confirm')).content, /Deleted/); assert.equal(existsSync(e.workDir!), false); assert.ok(existsSync(workRoot));
});

test('delete: cannot remove the other configured root nested inside a hand directory', async () => {
  const dir = tmp(); const f = fixture({ workRoot: join(dir, 'hand-files', 'scout', 'work-root'), handsDir: join(dir, 'hand-files') });
  const e = f.add({ handDir: join(dir, 'hand-files', 'scout'), workDir: undefined });
  assert.match((await f.run('delete scout confirm')).content, /refusing to delete a configured root/); assert.ok(existsSync(e.handDir));
});

test('delete: path becomes a symlink between dry validation and removal; mutation revalidation refuses', async () => {
  const f = fixture(); const e = f.add();
  let checks = 0;
  const exec = f.host.exec.bind(f.host);
  f.host.exec = async (cmd, args, opts) => {
    if (args[1] === HAND_PROCESSES_JS && ++checks === 2) {
      rmSync(e.workDir!, { recursive: true }); symlinkSync(f.dir, e.workDir!);
    }
    return exec(cmd, args, opts);
  };
  assert.match((await f.run('delete scout confirm')).content, /Deletion incomplete: symlink refused/);
  assert.ok(existsSync(e.handDir)); assert.equal(f.registry.all().length, 1); assert.deepEqual(f.deactivated, []);
});

test('delete: stopped status is rechecked at confirmation before any mutation', async () => {
  const f = fixture(); const e = f.add(); const before = readFileSync(f.registryFile, 'utf8'); let checks = 0;
  const exec = f.host.exec.bind(f.host);
  f.host.exec = async (cmd, args, opts) => {
    if (args[1] === HAND_PROCESSES_JS && ++checks === 2) f.state.process = true;
    return exec(cmd, args, opts);
  };
  assert.match((await f.run('delete scout confirm')).content, /no longer stopped/); f.unchanged(e, before);
});

for (const mode of ['absent', 'command', 'environment', 'cwd', 'zombie', 'other-user', 'disappeared', 'unreadable', 'unreadable-with-live-match', 'root-owned-unreadable', 'ownership-changed']) test(`process scanner snapshot: ${mode}`, () => {
  const args = [{ handDir: '/hands/scout', workDir: '/work/scout', sessionId: 'session' }];
  const missing = () => { throw Object.assign(Error('gone'), { code: 'ESRCH' }); };
  let stdout = '';
  let ownerChecks = 0;
  const fs = {
    statSync(p: string) { if (mode === 'disappeared' && p !== '/proc/self') return missing(); return { uid: p !== '/proc/self' && (mode === 'other-user' || mode === 'root-owned-unreadable' || mode === 'ownership-changed' && ++ownerChecks > 1) ? 0 : 1 }; },
    readdirSync() { return mode === 'unreadable-with-live-match' ? ['123', '124', '999'] : ['123', '999']; },
    readFileSync(p: string) {
      if (p.endsWith('/stat')) return '123 (fixture) ' + ['S', '1', ...Array(17).fill('0'), '100'].join(' ');
      if (p.endsWith('/cmdline')) {
        if (p.includes('/124/') || mode === 'command') return 'claude\0--resume\0session\0';
        return mode === 'zombie' ? '' : 'unrelated\0';
      }
      if (mode.startsWith('unreadable') || mode === 'root-owned-unreadable' || mode === 'ownership-changed') throw Object.assign(Error('unreadable'), { code: 'EACCES' });
      return mode === 'environment' ? 'MCPL_BRIDGE_CONFIG=/hands/scout/bridge.json\0' : 'UNRELATED=secret-not-to-print\0';
    },
    readlinkSync() { return mode === 'cwd' ? '/work/scout/subdir' : '/elsewhere'; },
  };
  const evaluate = () => runInNewContext(HAND_PROCESSES_JS, {
    require: (name: string) => name === 'node:fs' ? fs : pathModule,
    process: { argv: ['node', JSON.stringify(args)], pid: 999 }, console: { log: (s: string) => { stdout += s; } },
  });
  if (mode === 'unreadable' || mode === 'ownership-changed') { evaluate(); assert.equal(JSON.parse(stdout).error, 'unreadable-process'); }
  else if (mode === 'unreadable-with-live-match') { evaluate(); assert.equal(JSON.parse(stdout).running, true); }
  else { evaluate(); assert.equal(stdout, ['command', 'environment', 'cwd', 'unreadable-with-live-match'].includes(mode) ? 'true' : 'false'); }
  assert.equal(stdout.includes('secret'), false);
});

test('delete: partial filesystem cleanup keeps registry for a successful retry', async () => {
  const f = fixture(); const e = f.add(); const exec = f.host.exec.bind(f.host); let failed = false;
  f.host.exec = async (cmd, args, opts) => {
    if (args[1] === DELETE_PATHS_JS && JSON.parse(args[2])[1] && !failed) {
      failed = true; rmSync(e.handDir, { recursive: true });
      return { stdout: JSON.stringify({ removed: [e.handDir], error: 'simulated second directory failure' }) };
    }
    return exec(cmd, args, opts);
  };
  assert.match((await f.run('delete scout confirm')).content, /Deletion incomplete/);
  assert.equal(f.registry.all().length, 1); assert.ok(existsSync(e.workDir!)); assert.deepEqual(f.deactivated, []);
  assert.match((await f.run('delete scout confirm')).content, /Deleted/);
  assert.deepEqual(f.registry.all(), []); assert.equal(existsSync(e.workDir!), false);
});

test('delete: fd-anchored removal refuses a link swapped after lstat, without touching outside data', async () => {
  const f = fixture(); const e = f.add(); const exec = f.host.exec.bind(f.host);
  const outside = join(f.dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'sentinel'), 'keep');
  f.host.exec = async (cmd, args, opts) => {
    if (args[1] === DELETE_PATHS_JS && JSON.parse(args[2])[1]) {
      const hook = `const hookedFs = require('node:fs'), originalOpen = hookedFs.openSync; let swapped = false;
        hookedFs.openSync = function(p, flags, ...rest) {
          if (!swapped && p.startsWith('/proc/self/fd/') && p.endsWith('/cc-scout') && (flags & hookedFs.constants.O_DIRECTORY)) {
            swapped = true; hookedFs.renameSync(${JSON.stringify(e.handDir)}, ${JSON.stringify(e.handDir + '.parked')});
            hookedFs.symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(e.handDir)});
          }
          return originalOpen.call(this, p, flags, ...rest);
        };\n`;
      return exec(cmd, ['-e', hook + args[1], ...args.slice(2)], opts);
    }
    return exec(cmd, args, opts);
  };
  assert.match((await f.run('delete scout confirm')).content, /Deletion incomplete/);
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'keep');
  assert.ok(existsSync(e.handDir + '.parked')); assert.equal(f.registry.all().length, 1); assert.deepEqual(f.deactivated, []);
});

test('delete: failed provisioning with no bot is locally deletable by owner', async () => {
  const f = fixture(); const e = f.add({ status: 'failed', spawnedBy: undefined, botUserId: 0, botEmail: '', botCreatedBySpawner: undefined });
  assert.match((await f.run('delete scout confirm', 9)).content, /Deleted/);
  assert.equal(existsSync(e.handDir), false); assert.deepEqual(f.deactivated, []);
});

for (const kind of ['handDir', 'workDir'] as const) for (const empty of [false, true]) test(`delete: unproven ${kind}, empty=${empty}, is never recursively removed`, async () => {
  const f = fixture();
  const e = f.add({ status: 'failed', workDirReady: undefined, handDirReady: undefined });
  if (empty) rmSync(join(e[kind]!, 'keep'));
  const preview = await f.run('delete scout');
  assert.match(preview.content, empty ? /remove empty directory only/ : /kept: not created by this hand/);
  assert.ok(existsSync(e[kind]!));
  const result = await f.run('delete scout confirm');
  assert.match(result.content, /Deleted/);
  assert.equal(existsSync(e[kind]!), !empty);
  if (!empty) {
    assert.match(result.content, /kept: not created by this hand/);
    assert.equal(readFileSync(join(e[kind]!, 'keep'), 'utf8'), 'contents');
  }
});

test('delete: historical readiness is path-specific and explicit false hand provenance wins over legacy inference', async () => {
  const f = fixture();
  const old = f.add();
  const recent = f.add({ status: 'failed', workDirReady: undefined, handDirReady: undefined });
  const foreign = f.add({ handDir: join(f.config.handsDir, 'foreign'), workDir: join(f.dir, 'hands', 'foreign'),
    status: 'reaped', workDirReady: undefined, handDirReady: false });
  const result = await f.run('delete scout confirm');
  assert.match(result.content, /Deleted/);
  assert.equal(existsSync(old.handDir), false);
  assert.equal(existsSync(recent.workDir!), false);
  assert.ok(existsSync(foreign.handDir)); assert.ok(existsSync(foreign.workDir!));
});

test('delete: legacy launched hand has no deletion authority from status or readiness', async () => {
  const f = fixture(); const e = f.add({ handDirReady: undefined, workDirReady: undefined });
  assert.match((await f.run('delete scout confirm')).content, /kept: not created by this hand/);
  assert.ok(existsSync(e.handDir)); assert.ok(existsSync(e.workDir!));
});

test('list stopped: failed hand names and check stages do not hide verified stopped hands', async () => {
  const f = fixture(); f.add();
  const other = f.add({ suffix: 'other', personaName: 'Other', tmuxSession: 'cc-other',
    handDir: join(f.config.handsDir, 'cc-other'), workDir: join(f.dir, 'hands', 'cc-other') });
  f.tmux.hasSession = async s => { if (s === other.tmuxSession) throw Error('private diagnostic'); return false; };
  let result = await f.run('list stopped');
  assert.match(result.content, /1 stopped hand/);
  assert.match(result.content, /Could not verify stopped hand \*\*Other\*\*.*tmux liveness check failed/);
  assert.doesNotMatch(result.content, /private diagnostic/);
  f.state.failProcess = true;
  result = await f.run('list stopped');
  assert.match(result.content, /process liveness check failed/);
});

for (const duringRemoval of [false, true]) test(`delete refuses a different device ${duringRemoval ? 'during removal' : 'in preview'}`, async () => {
  const f = fixture(); const e = f.add();
  const nested = join(e.workDir!, 'mount'); mkdirSync(nested); writeFileSync(join(nested, 'precious'), 'keep');
  const exec = f.host.exec.bind(f.host);
  f.host.exec = async (cmd, args, opts) => {
    if (args[1] === DELETE_PATHS_JS) {
      const hook = `const f=require('node:fs'), old=f.lstatSync;
        f.lstatSync=function(p,...rest) {
          const st=old.call(this,p,...rest);
          if (${duringRemoval ? "String(p).startsWith('/proc/self/fd/') && String(p).endsWith('/mount')" : 'p === ' + JSON.stringify(nested)}) {
            Object.defineProperty(st,'dev',{value:st.dev+1});
          }
          return st;
        };\n`;
      return exec(cmd, ['-e', hook + args[1], ...args.slice(2)], opts);
    }
    return exec(cmd, args, opts);
  };
  const result = await f.run('delete scout' + (duringRemoval ? ' confirm' : ''));
  assert.match(result.content, /mount point refused.*different device/);
  assert.equal(readFileSync(join(nested, 'precious'), 'utf8'), 'keep');
  assert.equal(f.registry.all().length, 1);
});

test('delete: empty unproven directory gaining data at rmdir is kept and reported', async () => {
  const f = fixture(); const e = f.add({ status: 'failed', handDirReady: false });
  rmSync(join(e.handDir, 'keep'));
  const exec = f.host.exec.bind(f.host);
  f.host.exec = async (cmd, args, opts) => {
    if (args[1] === DELETE_PATHS_JS && JSON.parse(args[2])[1]) {
      const hook = `const f=require('node:fs'), old=f.rmdirSync;
        f.rmdirSync=function(p,...rest) {
          if (f.realpathSync(p) === ${JSON.stringify(e.handDir)}) f.writeFileSync(p+'/precious','keep');
          return old.call(this,p,...rest);
        };\n`;
      return exec(cmd, ['-e', hook + args[1], ...args.slice(2)], opts);
    }
    return exec(cmd, args, opts);
  };
  const result = await f.run('delete scout confirm');
  assert.match(result.content, /Deleted.*kept: not created by this hand/s);
  assert.equal(readFileSync(join(e.handDir, 'precious'), 'utf8'), 'keep');
});

test('delete: proven historical parent cannot swallow an unproven child', async () => {
  const f = fixture(); const parent = f.add();
  const child = f.add({ handDir: join(parent.handDir, 'foreign'), handDirReady: false, status: 'failed' });
  for (const suffix of ['', ' confirm']) {
    assert.match((await f.run('delete scout' + suffix)).content, /kept: not created by this hand/);
    assert.equal(readFileSync(join(child.handDir, 'keep'), 'utf8'), 'contents');
  }
  assert.ok(existsSync(parent.handDir));
});

for (const stage of ['lstat', 'open'] as const) test('delete: identity replacement at removal ' + stage + ' is kept', async () => {
  const f = fixture(); const e = f.add();
  const exec = f.host.exec.bind(f.host);
  f.host.exec = async (cmd, args, opts) => {
    if (args[1] === DELETE_PATHS_JS && JSON.parse(args[2])[1]) {
      const hook = `const f=require('node:fs'), original=f.${stage === 'open' ? 'openSync' : 'lstatSync'};
        let replaced=false;
        f.${stage === 'open' ? 'openSync' : 'lstatSync'}=function(p,...rest) {
          if(!replaced && typeof p==='string' && p.startsWith('/proc/self/fd/') &&
             p.endsWith('/cc-scout') && f.realpathSync(p)===${JSON.stringify(e.handDir)}) {
            replaced=true; f.renameSync(p,${JSON.stringify(e.handDir + '.retired')});
            f.mkdirSync(p); f.writeFileSync(p+'/precious','foreign');
          }
          return original.call(this,p,...rest);
        };\n`;
      return exec(cmd, ['-e', hook + args[1], ...args.slice(2)], opts);
    }
    return exec(cmd, args, opts);
  };
  assert.match((await f.run('delete scout confirm')).content, /kept: not created by this hand/);
  assert.equal(readFileSync(join(e.handDir, 'precious'), 'utf8'), 'foreign');
  assert.equal(readFileSync(join(e.handDir + '.retired', 'keep'), 'utf8'), 'contents');
});

test('delete reply reports the safe exec cause, not private failure detail', async () => {
  const f = fixture(); f.add();
  const original = f.host.exec;
  f.host.exec = async (cmd, args) => {
    if (args[1] === HAND_PROCESSES_JS) throw Object.assign(Error('/secret/node'), {code: 'ENOENT', stderr: 'private-token'});
    return original(cmd, args);
  };
  const result = await f.run('delete scout');
  assert.match(result.content, /process liveness check failed \(exec ENOENT; stderr present\)/);
  assert.doesNotMatch(result.content, /secret|private-token/);
});

test('real moved target pane: live hand stays not deletable', async t => {
  if (process.platform !== 'linux') return t.skip('requires Linux prctl');
  if (spawnSync('tmux', ['-V']).status !== 0 || spawnSync('python3', ['-c', 'import ctypes; assert ctypes.CDLL(None).prctl(4,0,0,0,0)==0']).status !== 0) return t.skip('requires tmux and python3/prctl');
  const f = fixture(); const e = f.add();
  const before = readFileSync(f.registryFile, 'utf8');
  const local = new LocalHost();
  // Scope enumeration to this dispatch's target PID; all per-PID reads remain real.
  // The host has unrelated unreadable daemons which would mask this finding.
  f.host.exec = async (cmd, args) => {
    if (args[0] === '-e' && args[1].includes("const fs = require('node:fs')")) {
      const prefix = `const realReadDir = require('node:fs').readdirSync; require('node:fs').readdirSync = function(p, ...a) { return p === '/proc' ? [String(${pid})] : realReadDir.call(this,p,...a); };\n`;
      return local.exec(cmd, [args[0], prefix + args[1], ...args.slice(2)]);
    }
    return local.exec(cmd,args);
  };
  const realTmux = new Tmux(local, f.config.tmuxSocket);
  f.tmux.hasSession = realTmux.hasSession.bind(realTmux);
  f.tmux.otherPaneRoots = realTmux.otherPaneRoots.bind(realTmux);
  const script = join(f.dir, 'worker.py');
  const ready = join(f.dir, 'ready');
  writeFileSync(script, 'import ctypes,os,time\nassert ctypes.CDLL(None).prctl(4,0,0,0,0)==0\nopen('+JSON.stringify(ready)+',"w").write(str(os.getpid()))\ntime.sleep(60)\n');
  const tx = (args: string[]) => local.exec('tmux', ['-S', f.config.tmuxSocket!, ...args]);
  let pid = 0;
  try {
    await tx(['-f', '/dev/null', 'new-session', '-d', '-s', 'other', 'exec sleep 60']);
    await tx(['new-session', '-d', '-s', e.tmuxSession, '-c', e.handDir, 'exec python3 '+script]);
    for (let i=0; i<100 && !existsSync(ready); i++) await new Promise(r => setTimeout(r,20));
    assert.ok(existsSync(ready)); pid = +readFileSync(ready, 'utf8');
    assert.equal(lstatSync('/proc/'+pid).uid, process.getuid!());
    try { readFileSync('/proc/'+pid+'/environ'); return t.skip('host permits reading nondumpable environ'); }
    catch (err) { assert.equal((err as NodeJS.ErrnoException).code, 'EACCES'); }
    assert.throws(() => readFileSync('/proc/'+pid+'/cwd'), {code:'EACCES'});
    await tx(['move-window', '-s', e.tmuxSession+':0', '-t', 'other:1']);
    assert.equal(await realTmux.hasSession(e.tmuxSession), false);
    const scan = await f.host.exec(process.execPath, ['-e', HAND_PROCESSES_JS, JSON.stringify([e]), JSON.stringify(await realTmux.otherPaneRoots([e.tmuxSession]))]);
    assert.equal(JSON.parse(scan.stdout).error, 'unreadable-process');
    const listing = await f.run('list stopped');
    assert.match(listing.content, /No verified stopped hands/);
    assert.match(listing.content, /unreadable-process/);
    const result = await f.run('delete scout confirm');
    assert.match(result.content, /unreadable-process/);
    f.unchanged(e, before);
    assert.equal(existsSync(e.handDir), true);
    assert.equal(existsSync(e.workDir!), true);
    process.kill(pid, 0);
  } finally {
    await tx(['kill-server']).catch(() => {});
    rmSync(f.dir, {recursive: true, force: true});
  }
});


test('actual delete with missing node reports safe exec classification', async()=>{
  const f=fixture({nodeBin:'/nonexistent-review-node'}); f.add();
  f.host.exec=new LocalHost().exec.bind(new LocalHost());
  try {
    const listing=await f.run('list stopped');assert.match(listing.content,/exec ENOENT/);
    const result=await f.run('delete scout');
    assert.match(result.content,/exec ENOENT/);

  } finally {rmSync(f.dir,{recursive:true,force:true});}
});
test('actual delete numeric exec failure never prints raw stderr or command line', async()=>{
  const f=fixture();f.add();
  const executable=join(f.dir,'failed-node');
  writeFileSync(executable,'#!/bin/sh\nprintf "REVIEW-STDERR-SENTINEL /foreign/process/private-path\\n" >&2\nexit 17\n',{mode:0o700});
  f.config.nodeBin=executable;
  f.host.exec=new LocalHost().exec.bind(new LocalHost());
  const logs:string[]=[];const original=console.log;const warn=console.warn;console.warn=console.log=(...args)=>logs.push(args.join(' '));
  try {
    const result=await f.run('delete scout');
    assert.match(result.content,/exec exit-17; stderr present/);
    const combined=logs.join('\n');
    assert.doesNotMatch(combined + result.content, /REVIEW-STDERR-SENTINEL|Command failed:|const fs = require|foreign\/process/);
  } finally {console.log=original;console.warn=warn;rmSync(f.dir,{recursive:true,force:true});}
});

for (const stage of ['preview', 'remove', 'process', 'tmux'] as const) test(`delete ${stage} exec failure is sanitized and preserves the hand`, async () => {
  const f = fixture(); const e = f.add();
  const before = readFileSync(f.registryFile, 'utf8');
  const originalExec = f.host.exec.bind(f.host);
  const failure = () => { throw Object.assign(Error('PRIVATE-COMMAND PRIVATE-STDERR'), {code: 'EACCES', stderr: 'PRIVATE-STDERR permission denied'}); };
  f.host.exec = (cmd, args) => {
    if ((stage === 'process' && args[1] === HAND_PROCESSES_JS) ||
        (args[1] === DELETE_PATHS_JS && stage === (JSON.parse(args[2])[1] ? 'remove' : 'preview'))) failure();
    return originalExec(cmd, args);
  };
  if (stage === 'tmux') f.tmux.hasSession = async () => failure();
  const logs: string[] = []; const log = console.log; const warn = console.warn;
  console.log = console.warn = (...args) => { logs.push(args.join(' ')); };
  try {
    const result = await f.run('delete scout confirm');
    assert.match(result.content, /exec EACCES; stderr permission/);
    assert.doesNotMatch(logs.join('\n') + result.content, /PRIVATE/);
    f.unchanged(e, before);
  } finally {
    console.log = log; console.warn = warn;
    rmSync(f.dir, {recursive: true, force: true});
  }
});

test('delete generic parse failure does not log exception message or helper output', async () => {
  const f = fixture(); const e = f.add();
  const before = readFileSync(f.registryFile, 'utf8');
  f.host.exec = async () => ({stdout: 'PRIVATE-INVALID-JSON'});
  const logs: string[] = []; const log = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  try {
    const result = await f.run('delete scout confirm');
    assert.match(result.content, /path, liveness or registry check failed/);
    assert.doesNotMatch(logs.join('\n') + result.content, /PRIVATE/);
    f.unchanged(e, before);
  } finally {
    console.log = log;
    rmSync(f.dir, {recursive: true, force: true});
  }
});

for (const stage of ['preview','remove'] as const) test(`actual ${stage} filesystem exception is bounded and preserves the hand`, async () => {
  const f=fixture(); const e=f.add(); const before=readFileSync(f.registryFile,'utf8');
  const privateDir=join(e.handDir,'REVIEW-PRIVATE-FILENAME'); mkdirSync(privateDir);
  const original=f.host.exec.bind(f.host);
  f.host.exec=async(cmd,args)=>{
    if(args[1]===DELETE_PATHS_JS && JSON.parse(args[2])[1]===(stage==='remove')) chmodSync(privateDir,0);
    return original(cmd,args);
  };
  const logs:string[]=[]; const log=console.log; const warn=console.warn;
  console.log=console.warn=(...args)=>logs.push(args.join(' '));
  try {
    const result=await f.run('delete scout'+(stage==='remove'?' confirm':''));
    assert.match(result.content,/filesystem; EACCES; preview; hand dir/);
    assert.doesNotMatch(result.content + logs.join('\n'), /REVIEW-PRIVATE-FILENAME|scandir|permission denied/);
    assert.ok(!result.content.includes(privateDir));
    f.unchanged(e,before);
  } finally {console.log=log;console.warn=warn;chmodSync(privateDir,0o700);rmSync(f.dir,{recursive:true,force:true});}
});

for (const error of ['PRIVATE-message /child/path', {cause: 'PRIVATE-cause', errno: 'PRIVATE-errno', stage: 'PRIVATE-stage', rootKind: 'PRIVATE-root'}]) {
  test('path helper success-exec error fields are allowlisted before rendering', async () => {
    const f = fixture(); const e = f.add(); const before = readFileSync(f.registryFile, 'utf8');
    const original = f.host.exec.bind(f.host);
    f.host.exec = (cmd, args) => args[1] === DELETE_PATHS_JS ? Promise.resolve({stdout: JSON.stringify({error, removed: []})}) : original(cmd, args);
    try {
      const result = await f.run('delete scout confirm');
      assert.match(result.content, /helper-error; unexpected; unknown-stage/);
      assert.doesNotMatch(result.content, /PRIVATE|child\/path/);
      f.unchanged(e, before);
    } finally { rmSync(f.dir, {recursive: true, force: true}); }
  });
}

// Permanent snapshot of review run run-01M7DE6T3SE3QFT18EVJ216HWC:
// same-uid hand moved to writable init.scope, renamed (sd-pam), reparented
// to the real manager and made nondumpable. No host cgroups are modified.
test('reviewer init.scope forgery remains ambiguous and cannot delete a live hand', async () => {
  const f = fixture(); const e = f.add();
  const before = readFileSync(f.registryFile, 'utf8');
  const result = managerSnapshot({childStart: '110296500', parentStart: '39736'});
  assert.equal('user-manager' in result, false);
  assert.equal(result.ambiguous, 1);
  assert.equal(result.diagnostics[0].classification, 'ambiguous');
  const original = f.host.exec.bind(f.host);
  f.host.exec = async (cmd, args) => args[1] === HAND_PROCESSES_JS
    ? {stdout: JSON.stringify(result)} : original(cmd, args);
  assert.match((await f.run('list stopped')).content, /unreadable-process/);
  assert.match((await f.run('delete scout confirm')).content, /unreadable-process/);
  f.unchanged(e, before);
});

test('real same-uid sd-pam remains ambiguous and cannot delete (no sudo)', async t => {
  if (process.platform !== 'linux') return t.skip('requires Linux proc');
  const uid = process.getuid!();
  const pid = readdirSync('/proc').find(p => {
    try { return /^\d+$/.test(p) && statSync('/proc/' + p).uid === uid && readFileSync('/proc/' + p + '/comm', 'utf8') === '(sd-pam)\n'; }
    catch { return false; }
  });
  if (!pid) return t.skip('no existing same-uid sd-pam');
  try { readFileSync(`/proc/${pid}/environ`); return t.skip('sd-pam environ readable on this host'); }
  catch (e) { assert.ok(['EACCES', 'EPERM'].includes((e as NodeJS.ErrnoException).code!)); }
  const ppid = Number(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[1]);
  // Only scope enumeration; all candidate kernel reads and helper logic are real.
  const hook = `const f = require('node:fs'), original = f.readdirSync; f.readdirSync = function(p, ...args) { return p === '/proc' ? [${JSON.stringify(pid)}] : original.call(this, p, ...args); };\n`;
  const {stdout} = await new LocalHost().exec(process.execPath, ['-e', hook + HAND_PROCESSES_JS, JSON.stringify([{handDir: '/hands/target'}])]);
  const result = JSON.parse(stdout);
  assert.equal(result.ambiguous, 1);
  assert.equal(result.error, 'unreadable-process');
  assert.equal(result.diagnostics[0].classification, 'ambiguous');
  assert.equal(result.diagnostics[0].pid, Number(pid));
  const f = fixture(); const e = f.add();
  try {
    const before = readFileSync(f.registryFile, 'utf8');
    const original = f.host.exec.bind(f.host);
    f.host.exec = async (cmd, args) => args[1] === HAND_PROCESSES_JS
      ? {stdout: JSON.stringify(result)} : original(cmd, args);
    assert.match((await f.run('delete scout confirm')).content, /unreadable-process/);
    f.unchanged(e, before);
  } finally { rmSync(f.dir, {recursive: true, force: true}); }
  t.diagnostic(`real sd-pam: uid=${uid}; ppid=${ppid}; ambiguous=${result.ambiguous}`);
});

test('real zero-argv nondumpable child blocks listing and deletion', { timeout: 15000 }, async t => {
  if (process.platform !== 'linux') return t.skip('requires Linux prctl and /proc');
  if (spawnSync('cc', ['--version']).error) return t.skip('requires a C compiler');
  const f = fixture(); const e = f.add();
  const before = readFileSync(f.registryFile, 'utf8');
  const executable = join(f.dir, 'empty-argv');
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const compiled = spawnSync('cc', [new URL('./fixtures/empty-argv.c', import.meta.url).pathname, '-o', executable], { encoding: 'utf8' });
    assert.equal(compiled.status, 0, compiled.stderr);
    child = spawn(executable, [], { cwd: e.handDir, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    const worker = child;
    await Promise.race([
      once(worker.stdout!, 'data'),
      once(worker, 'exit').then(() => { throw Error('worker exited before readiness'); }),
    ]);
    const pid = worker.pid!;
    assert.equal(statSync(`/proc/${pid}`).uid, process.getuid!());
    assert.ok(!readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').some(Boolean));
    try { readFileSync(`/proc/${pid}/environ`); return t.skip('host permits reading nondumpable environ'); }
    catch (err) { assert.equal((err as NodeJS.ErrnoException).code, 'EACCES'); }
    const local = new LocalHost();
    // Only enumeration is scoped; every per-PID read is real. Unrelated host
    // daemons must not mask a regression by independently causing ambiguity.
    const hook = `const fsHook=require('node:fs'),old=fsHook.readdirSync; fsHook.readdirSync=function(p,...a){return p==='/proc'?[String(${pid})]:old.call(this,p,...a);};\n`;
    f.host.exec = async (cmd, args) => args[1] === HAND_PROCESSES_JS
      ? local.exec(cmd, ['-e', hook + args[1], ...args.slice(2)]) : local.exec(cmd, args);
    const scan = JSON.parse((await f.host.exec(process.execPath, ['-e', HAND_PROCESSES_JS, JSON.stringify([e])])).stdout);
    assert.equal(scan.error, 'unreadable-process');
    assert.equal(scan.ambiguous, 1);
    const listing = await f.run('list stopped');
    assert.match(listing.content, /No verified stopped hands/);
    assert.match(listing.content, /unreadable-process/);
    f.unchanged(e, before);
    for (const command of ['delete scout', 'delete scout confirm']) {
      assert.match((await f.run(command)).content, /unreadable-process/);
      f.unchanged(e, before);
      assert.equal(existsSync(e.handDir), true);
      assert.equal(existsSync(e.workDir!), true);
      process.kill(pid, 0);
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit'); child.kill(); await done;
    }
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// Real reviewer repro: the leader exits but its worker retains the hand cwd.
test('pthread_exit leader cannot hide a live worker or permit deletion', { timeout: 15000 }, async t => {
  if (process.platform !== 'linux') return t.skip('requires Linux /proc');
  if (spawnSync('cc', ['--version']).error) return t.skip('requires a C compiler');
  const f = fixture(); const e = f.add();
  const before = readFileSync(f.registryFile, 'utf8');
  const executable = join(f.dir, 'leader-exit');
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const compiled = spawnSync('cc', ['-pthread', new URL('./fixtures/leader-exit.c', import.meta.url).pathname, '-o', executable], {encoding: 'utf8'});
    assert.equal(compiled.status, 0, compiled.stderr);
    child = spawn(executable, [], {cwd: e.handDir, env: {PATH: process.env.PATH}, stdio: ['ignore', 'pipe', 'pipe']});
    const worker = child;
    const ready = await Promise.race([
      once(worker.stdout!, 'data'),
      once(worker, 'exit').then(() => { throw Error('worker exited before readiness'); }),
    ]);
    const tid = Number(/tid=(\d+)/.exec(String(ready[0]))![1]);
    const pid = worker.pid!;
    assert.notEqual(tid, pid);
    assert.equal(statSync('/proc/' + pid).uid, process.getuid!());
    assert.equal(readFileSync('/proc/' + pid + '/cmdline', 'utf8'), '');
    assert.throws(() => readlinkSync('/proc/' + pid + '/cwd'), {code: 'ENOENT'});
    const task = '/proc/' + pid + '/task/' + tid;
    assert.equal(readlinkSync(task + '/cwd'), e.handDir);
    const local = new LocalHost();
    // Scope only top-level enumeration; task listing and all fields are real.
    const hook = `const f=require('node:fs'),old=f.readdirSync;f.readdirSync=(p,...a)=>p==='/proc'?['${pid}']:old.call(f,p,...a);\n`;
    f.host.exec = (cmd, args) => args[1] === HAND_PROCESSES_JS
      ? local.exec(cmd, ['-e', hook + args[1], ...args.slice(2)]) : local.exec(cmd, args);
    const scan = JSON.parse((await f.host.exec(process.execPath, ['-e', HAND_PROCESSES_JS, JSON.stringify([e])])).stdout);
    assert.equal(scan.running, true);
    assert.equal(scan.ambiguous, 1); // Leader denial survives its missing cwd.
    assert.equal(scan.diagnostics[0].errno, 'EACCES');
    assert.match((await f.run('list stopped')).content, /No stopped hands|No verified stopped hands/);
    f.unchanged(e, before);
    for (const command of ['delete scout', 'delete scout confirm']) {
      const result = await f.run(command);
      assert.match(result.content, /Cannot delete: hand must be STOPPED.*nothing was changed/);
      f.unchanged(e, before);
      assert.equal(readlinkSync(task + '/cwd'), e.handDir);
      assert.match(readFileSync(task + '/stat', 'utf8').split(') ')[1], /^S /);
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit'); child.kill(); await done;
    }
    rmSync(f.dir, {recursive: true, force: true});
  }
});

function legacy(f: ReturnType<typeof fixture>, patch: Partial<BotEntry> = {}) {
  return f.add({ handDirReady: false, workDirReady: false, botCreatedBySpawner: undefined, ...patch });
}
async function forcePreview(f: ReturnType<typeof fixture>) {
  const reply = (await f.run('delete scout confirm force-legacy', 9)).content;
  assert.match(reply, /Force-legacy preview/);
  const command = reply.match(/delete cc-scout confirm force-legacy [a-f0-9]+/)![0];
  return { reply, command };
}

test('force legacy requires owner and separate single-use preview; deletes real nonempty dirs without markers', async () => {
  const f = fixture(); const e = legacy(f);
  assert.match((await f.run('delete scout confirm force-legacy')).content, /configured force-legacy admins/);
  const { reply, command } = await forcePreview(f);
  assert.ok(reply.includes(e.handDir)); assert.ok(reply.includes(e.workDir!)); assert.match(reply, /user 42/);
  assert.ok(existsSync(e.handDir)); assert.equal(existsSync(join(e.handDir, '.cc-spawner-owner')), false);
  assert.match((await f.run(command, 9)).content, /Deleted/);
  assert.equal(existsSync(e.handDir), false); assert.equal(existsSync(e.workDir!), false);
  assert.deepEqual(f.deactivated, [42]); assert.equal(f.registry.all().length, 0);
  assert.match((await f.run(command, 9)).content, /not found/);
});

test('force legacy retains implicit projectDir and detects real process there', async () => {
  const f = fixture(); const e = legacy(f, { workDir: undefined });
  const { reply, command } = await forcePreview(f);
  assert.match(reply, /projectDir is kept/);
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], { cwd: f.config.projectDir, stdio: ['ignore', 'pipe', 'pipe'] });
  try { await once(child.stdout!, 'data'); assert.equal(await handStopped(new LocalHost(), f.tmux, f.config, [e]), false); }
  finally { child.kill(); await once(child, 'exit'); }
  assert.match((await f.run(command, 9)).content, /Deleted/); assert.ok(existsSync(f.config.projectDir));
});

test('force legacy re-previews replacement inode and registry changes, and liveness still blocks', async () => {
  const f = fixture(); const e = legacy(f);
  const { command } = await forcePreview(f);
  renameSync(e.handDir, e.handDir + '.old'); mkdirSync(e.handDir); writeFileSync(join(e.handDir, 'new'), 'new');
  assert.match((await f.run(command, 9)).content, /Force-legacy preview/);
  assert.ok(existsSync(join(e.handDir, 'new')));
  const next = await forcePreview(f);
  f.registry.update(e, { botUserId: 43 });
  assert.match((await f.run(next.command, 9)).content, /Force-legacy preview/);
  const again = await forcePreview(f); f.state.process = true;
  assert.match((await f.run(again.command, 9)).content, /STOPPED/);
  assert.deepEqual(f.deactivated, []);
});

for (const mode of ['root', 'foreign', 'symlink', 'shared', 'bot', 'canonical'] as const) test('force legacy refuses ' + mode, async () => {
  const f = fixture(); const e = legacy(f);
  if (mode === 'root') f.registry.update(e, { handDir: f.config.handsDir });
  if (mode === 'foreign') f.registry.update(e, { handDir: join(f.config.handsDir, 'foreign') });
  if (mode === 'symlink') symlinkSync(f.dir, join(e.handDir, 'link'));
  if (['shared', 'bot', 'canonical'].includes(mode)) {
    let workDir: string | undefined = join(f.config.projectDir, 'other-work');
    if (mode === 'shared') workDir = join(e.workDir!, 'nested');
    if (mode === 'canonical') { workDir = join(f.dir, 'alias'); symlinkSync(e.workDir!, workDir); }
    legacy(f, { suffix: 'other', friendlyName: 'Other', tmuxSession: 'cc-other', handDir: join(f.config.handsDir, 'cc-other'), workDir, botUserId: mode === 'bot' ? 42 : 43 });
  }
  const reply = (await f.run('delete scout confirm force-legacy', 9)).content;
  assert.doesNotMatch(reply, /Force-legacy preview/); assert.match(reply, /refused|shared|subtree/);
  assert.ok(existsSync(join(f.config.handsDir, 'cc-scout', 'keep'))); assert.deepEqual(f.deactivated, []);
});

test('list stopped size sort and creator filters combine; unknown does not mean mine', async () => {
  const f = fixture(); legacy(f);
  const other = legacy(f, { suffix: 'other', friendlyName: 'Other', personaName: 'Other', tmuxSession: 'cc-other', handDir: join(f.config.handsDir, 'cc-other'), workDir: join(f.config.projectDir, 'other-work'), spawnedBy: undefined });
  writeFileSync(join(other.workDir!, 'big'), Buffer.alloc(1000));
  const sorted = (await f.run('list stopped by size')).content;
  assert.ok(sorted.indexOf('**Other**') < sorted.indexOf('**[cc-opus')); assert.match(sorted, /0 MB/);
  assert.doesNotMatch((await f.run('list stopped mine by size')).content, /\*\*Other\*\*/);
  assert.doesNotMatch((await f.run('list stopped by size by=unknown')).content, /Pathfinder/);
  assert.match((await f.run('list stopped by=1')).content, /Pathfinder/);
});

test('force legacy token expires and cannot cross owners or authorize new shared references', async () => {
  const f = fixture(); const e = legacy(f);
  const first = await forcePreview(f);
  assert.match((await f.run(first.command, 1)).content, /configured force-legacy admins/);
  const now = Date.now;
  try {
    Date.now = () => now() + 6 * 60_000;
    assert.match((await f.run(first.command, 9)).content, /Force-legacy preview/);
  } finally { Date.now = now; }
  const second = await forcePreview(f);
  legacy(f, { suffix: 'other', friendlyName: 'Other', tmuxSession: 'cc-other', handDir: join(f.config.handsDir, 'cc-other'), workDir: e.workDir, botUserId: 43 });
  assert.match((await f.run(second.command, 9)).content, /shared/);
  assert.ok(existsSync(e.handDir)); assert.deepEqual(f.deactivated, []);
});

test('force legacy protects projectDir nested inside a planned hand directory', async () => {
  const dir = tmp(); const handsDir = join(dir, 'hand-files');
  const f = fixture({ handsDir, projectDir: join(handsDir, 'cc-scout', 'project'), workRoot: join(dir, 'work') });
  const e = legacy(f);
  mkdirSync(f.config.projectDir, { recursive: true }); writeFileSync(join(f.config.projectDir, 'sentinel'), 'keep');
  assert.match((await f.run('delete scout confirm force-legacy', 9)).content, /configured root/);
  assert.ok(existsSync(join(e.handDir, 'keep'))); assert.equal(readFileSync(join(f.config.projectDir, 'sentinel'), 'utf8'), 'keep');
  assert.deepEqual(f.deactivated, []);
});

for (const force of [false, true]) test('implicit projectDir does not share another hand subtree, force=' + force, async () => {
  const f = fixture({ workRoot: undefined });
  const e = force ? legacy(f) : f.add();
  const other = legacy(f, { suffix: 'other', friendlyName: 'Other', tmuxSession: 'cc-other',
    handDir: join(f.config.handsDir, 'cc-other'), workDir: undefined, botUserId: 43 });
  const command = force ? (await forcePreview(f)).command : 'delete scout confirm';
  assert.match((await f.run(command, 9)).content, /Deleted/);
  assert.equal(existsSync(e.workDir!), false);
  assert.ok(existsSync(other.handDir)); assert.ok(existsSync(f.config.projectDir));
  assert.deepEqual(f.deactivated, [42]);
});

test('force legacy token ignores unrelated activity but binds reference changes', async () => {
  const f = fixture(); legacy(f);
  const other = legacy(f, { suffix: 'other', friendlyName: 'Other', tmuxSession: 'cc-other',
    handDir: join(f.config.handsDir, 'cc-other'), workDir: undefined, botUserId: 43 });
  const first = await forcePreview(f);
  f.registry.update(other, { seedFile: join(f.config.projectDir, 'new-seed') });
  assert.match((await f.run(first.command, 9)).content, /Force-legacy preview/);
  const next = await forcePreview(f);
  f.registry.update(other, { lastActivity: new Date().toISOString() });
  assert.match((await f.run(next.command, 9)).content, /Deleted/);
});


test('explicit admins work without an owner and cannot use ordinary owner-only deletion', async () => {
  const f = fixture({ ownerUserId: undefined, adminUserIds: [2, 9] }); const e = legacy(f);
  assert.match((await f.run('delete scout confirm', 2)).content, /Only this hand.s creator/);
  const reply = (await f.run('delete scout force-legacy', 2)).content;
  assert.match(reply, /Force-legacy preview/);
  assert.ok(existsSync(e.handDir)); assert.deepEqual(f.deactivated, []);
  const command = reply.match(/delete cc-scout confirm force-legacy [a-f0-9]+/)![0];
  assert.match((await f.run(command, 1)).content, /configured force-legacy admins/);
  assert.match((await f.run(command, 9)).content, /Force-legacy preview/);
  assert.match((await f.run(command, 2)).content, /Deleted/);
  assert.equal(existsSync(e.handDir), false); assert.deepEqual(f.deactivated, [42]);
});

for (const adminUserIds of [[], [2]]) test('explicit admin list replaces owner fallback: ' + JSON.stringify(adminUserIds), async () => {
  const f = fixture({ adminUserIds }); const e = legacy(f);
  for (const command of ['delete scout force-legacy', 'delete scout confirm force-legacy', 'delete scout confirm force-legacy fake']) {
    assert.match((await f.run(command, 9)).content, adminUserIds.length ? /configured force-legacy admins/ : /disabled/);
    assert.ok(existsSync(e.handDir)); assert.deepEqual(f.deactivated, []);
  }
});

test('admin removal revokes a pending legacy confirmation', async () => {
  const f = fixture({ ownerUserId: undefined, adminUserIds: [9] }); const e = legacy(f);
  const { command } = await forcePreview(f);
  f.config.adminUserIds = [];
  assert.match((await f.run(command, 9)).content, /disabled/);
  assert.ok(existsSync(e.handDir)); assert.deepEqual(f.deactivated, []);
});

for (const overrides of [{ allowedUsers: [1] }, { allowedStreams: ['elsewhere'] }]) test('force-legacy admins still need normal authorization ' + JSON.stringify(overrides), async () => {
  const f = fixture({ adminUserIds: [2], ...overrides }); const e = legacy(f);
  const reply = await f.run('delete scout force-legacy', 2);
  assert.doesNotMatch(reply.content, /Force-legacy preview/);
  assert.ok(existsSync(e.handDir)); assert.deepEqual(f.deactivated, []);
});

test('no owner and omitted admin list disables force-legacy', async () => {
  const f = fixture({ ownerUserId: null }); const e = legacy(f);
  assert.match((await f.run('delete scout force-legacy', 9)).content, /disabled/);
  assert.ok(existsSync(e.handDir)); assert.deepEqual(f.deactivated, []);
});
