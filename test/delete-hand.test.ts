import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
import type { Tmux } from '../src/tmux.js';
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
  const tmux = { async hasSession() { if (state.failTmux) throw Error('unavailable'); return state.tmux; } } as Tmux;
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
        entry[kind === 'handDir' ? 'handDirIdentity' : 'workDirIdentity'] = { dev, ino };
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
  f.registry.update(other, { handDir: join(f.config.handsDir, 'other'), workDir: undefined, botUserId: 42 });
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
  if (mode === 'unreadable') assert.throws(evaluate, /cannot rule out a running hand/);
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
