import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { HAND_PROCESSES_JS, handStopped } from '../src/delete-hand.js';
import { LocalHost, type AgentHost } from '../src/host.js';
import { Tmux } from '../src/tmux.js';
import type { SpawnerConfig } from '../src/config.js';
import type { BotEntry } from '../src/registry.js';

const entries = [{handDir: '/hands/target', workDir: '/work/target', sessionId: 'target', tmuxSession: 'target', status: 'reaped'}] as BotEntry[];
const cfg = {nodeBin: process.execPath} as SpawnerConfig;
const tmux = {hasSession: async () => false, otherPaneRoots: async () => []} as unknown as Tmux;
function snapshot(options: {related?: boolean; namespace?: boolean; errno?: string; marker?: boolean; reparent?: boolean} = {}) {
  let output = '', statReads = 0;
  const fs = {
    statSync: () => ({uid: 123}), readdirSync: () => ['20'],
    readFileSync(p: string) {
      if (p.endsWith('/cmdline')) return 'private-command\0';
      if (p.endsWith('/environ')) throw Object.assign(Error('/secret/path TOKEN=secret'), {code: options.errno ?? 'EACCES'});
      if (p.endsWith('/status')) return `Uid:\t123 123 123 123\nGid:\t123 123 123 123\nNSpid:\t20${options.namespace ? ' 1' : ''}\nDumpable:\t0\nName:\tsecret\n`;
      if (p.endsWith('/cgroup')) return '0::/private/secret.service';
      if (p.endsWith('/stat')) {
        statReads++;
        const fields = Array(20).fill('0'); fields[0] = 'S'; fields[1] = p === '/proc/20/stat' ? (options.reparent && statReads > 2 ? '1' : '10') : '1'; fields[19] = '100';
        return '20 (secret ) command) ' + fields.join(' ');
      }
      throw Error('unexpected fixture read');
    },
    readlinkSync() {
      if (options.marker) return '/hands/target';
      throw Object.assign(Error('secret cwd'), {code: 'EPERM'});
    },
  };
  runInNewContext(HAND_PROCESSES_JS, {require: (n: string) => n === 'node:fs' ? fs : path,
    process: {pid: 999, argv: ['node', JSON.stringify(entries), JSON.stringify(options.related ? [] : [{pid: 10, pane: '%1'}])]},
    console: {log: (s: string) => {output = s;}}});
  assert.doesNotMatch(output, /secret|private/);
  return JSON.parse(output);
}
for (const namespace of [false, true]) {
  test(`unreadable sibling under another live pane; namespace=${namespace}`, () => {
    const result = snapshot({namespace});
    assert.equal(result.running, false); assert.equal(result.error, 'unreadable-process');
    assert.equal(result.unreadable, 1); assert.equal(result.diagnostics[0].classification, 'ambiguous');
    assert.equal(result.diagnostics[0].namespaceDepth, namespace ? 2 : 1);
    assert.deepEqual(result.diagnostics[0].Dumpable, [0]);
    assert.equal(result.diagnostics[0].errno, 'EACCES');
    assert.equal(result.diagnostics[0].cgroup.nonRoot, true);
  });
  test(`unreadable possible target fails closed; namespace=${namespace}`, () => {
    assert.equal(snapshot({related: true, namespace}).error, 'unreadable-process');
  });
}
test('reparented processes remain ambiguous', () => assert.equal(snapshot({reparent: true}).error, 'unreadable-process'));
test('positive marker identifies a running hand despite unreadable fields', () => assert.equal(snapshot({marker: true}).running, true));
test('unexpected helper errno is structured and secret-free', () => {
  const result = snapshot({errno: 'EIO'});
  assert.equal(result.error, 'unreadable-process'); assert.equal(result.diagnostics[0].errno, 'EPERM');
});
for (const code of ['ENOENT', 'EACCES', 17]) test(`exec failure ${code} is classified without stderr disclosure`, async () => {
  const host = {exec: async () => {throw Object.assign(Error('/private/bin'), {code, stderr: 'secret token /private/path'});}} as unknown as AgentHost;
  await assert.rejects(handStopped(host, tmux, cfg, entries), new RegExp(`exec ${typeof code === 'number' ? 'exit-' : ''}${code}; stderr present`));
});
test('real missing node binary', async () => {
  await assert.rejects(handStopped(new LocalHost(), tmux, {nodeBin: '/nonexistent-liveness-node'} as SpawnerConfig, entries), /exec ENOENT/);
});
test('changing live panes cannot establish launch ownership', async () => {
  let calls = 0;
  const changing = {...tmux, otherPaneRoots: async () => ++calls === 1 ? [{pid: 10, pane: '%1'}] : []} as unknown as Tmux;
  const host = {exec: async () => ({stdout: JSON.stringify(snapshot())})} as unknown as AgentHost;
  await assert.rejects(handStopped(host, changing, cfg, entries), /unreadable-process/);
});
test('real Linux PR_SET_DUMPABLE=0 child remains ambiguous', async t => {
  if (process.platform !== 'linux') return t.skip('requires Linux prctl');
  const available = spawnSync('python3', ['-c', 'import ctypes; assert ctypes.CDLL(None).prctl(4,0,0,0,0)==0']);
  if (available.error || available.status !== 0) return t.skip('python3/prctl unavailable on this host');
  const child = spawn('python3', ['-c', 'import ctypes,time; assert ctypes.CDLL(None).prctl(4,0,0,0,0)==0; print("ready",flush=True); time.sleep(60)'], {stdio: ['ignore', 'pipe', 'pipe']});
  try {
    const [chunk] = await once(child.stdout!, 'data');
    assert.match(String(chunk), /ready/);
    try { readFileSync(`/proc/${child.pid}/environ`); return t.skip('host permits reading nondumpable environ'); }
    catch (e) { assert.ok(['EACCES','EPERM'].includes((e as NodeJS.ErrnoException).code!)); }
    const {stdout} = await new LocalHost().exec(process.execPath, ['-e', HAND_PROCESSES_JS, JSON.stringify(entries)]);
    const result = JSON.parse(stdout);
    assert.equal(result.error, 'unreadable-process');
    assert.ok(result.diagnostics.some((d: {pid: number}) => d.pid === child.pid));
    // The same real nondumpable child remains ambiguous with an other-pane
    // ancestry anchor (pane inventory is injected; /proc access remains real).
    const sibling = await new LocalHost().exec(process.execPath, ['-e', HAND_PROCESSES_JS, JSON.stringify(entries), JSON.stringify([{pid: process.pid, pane: '%99'}])]);
    assert.equal(JSON.parse(sibling.stdout).diagnostics.find((d: {pid: number}) => d.pid === child.pid).classification, 'ambiguous');
  } finally {
    const exit = once(child, 'exit'); child.kill(); await exit;
  }
});

test('diagnostic pane inventory omits target sessions and use the configured socket', async () => {
  const host = {exec: async (cmd: string, args: string[]) => {
    assert.equal(cmd, 'tmux');
    assert.deepEqual(args, ['-S', '/test/socket', 'list-panes', '-a', '-F', '#{pane_pid} #{pane_id} #{session_name}']);
    return {stdout: '10 %1 target\n11 %2 other\ninvalid\n'};
  }} as unknown as AgentHost;
  assert.deepEqual(await new Tmux(host, '/test/socket').otherPaneRoots(['target']), [{pid: 11, pane: '%2'}]);
});
test('unavailable pane evidence does not exclude an ambiguous process', async () => {
  const unavailable = {...tmux, otherPaneRoots: async () => {throw Error('secret stderr');}} as unknown as Tmux;
  const host = {exec: async (_cmd: string, args: string[]) => {
    assert.equal(args[3], '[]');
    return {stdout: JSON.stringify(snapshot({related: true}))};
  }} as unknown as AgentHost;
  await assert.rejects(handStopped(host, unavailable, cfg, entries), /unreadable-process.*EACCES.*unreadable=1/);
});

test('unavailable proc root returns a structured cause, not a thrown path', () => {
  let output = '';
  runInNewContext(HAND_PROCESSES_JS, {
    require: (n: string) => n === 'node:fs' ? {statSync() {throw Object.assign(Error('/secret/proc'), {code: 'EACCES'});}} : path,
    process: {pid: 999, argv: ['node', JSON.stringify(entries)]}, console: {log: (s: string) => {output = s;}},
  });
  assert.deepEqual(JSON.parse(output), {error: 'helper-error', errno: 'EACCES', stage: 'setup', unreadable: 0, diagnostics: []});
  assert.doesNotMatch(output, /secret/);
});

for (const mode of ['field-missing', 'task-missing', 'task-list-denied', 'task-denied', 'task-marker', 'gone', 'denied-then-gone', 'reused', 'readable'] as const) {
  test(`thread group snapshot: ${mode}`, () => {
    let output = '', owners = 0, starts = 0;
    const fail = (code: string): never => { throw Object.assign(Error('PRIVATE'), {code}); };
    const fs = {
      statSync(p: string) {
        if (p === '/proc/20' && ++owners > 1 && ['gone', 'denied-then-gone'].includes(mode)) fail('ENOENT');
        return {uid: 123};
      },
      readdirSync(p: string) {
        if (p === '/proc') return ['20'];
        if (mode === 'task-list-denied') fail('EACCES');
        return ['20', '21'];
      },
      readFileSync(p: string) {
        if (p.endsWith('/stat')) {
          const start = ++starts > 1 && mode === 'reused' ? '101' : '100';
          return '20 (fixture) ' + ['S', '1', ...Array(17).fill('0'), start].join(' ');
        }
        if (p.endsWith('/environ') && (mode === 'denied-then-gone' || mode === 'task-denied' && p.includes('/task/21/'))) fail('EACCES');
        if (p.endsWith('/cmdline')) return '';
        return '';
      },
      readlinkSync(p: string) {
        if (p === '/proc/20/cwd' && ['field-missing', 'gone', 'denied-then-gone'].includes(mode)) fail('ENOENT');
        if (p.includes('/task/21/')) {
          if (mode === 'task-missing') fail('ESRCH');
          if (mode === 'task-marker') return '/hands/target';
        }
        return '/unrelated';
      },
    };
    runInNewContext(HAND_PROCESSES_JS, {
      require: (n: string) => n === 'node:fs' ? fs : path,
      process: {pid: 999, argv: ['node', JSON.stringify(entries)]},
      console: {log: (s: string) => {output = s;}},
    });
    const result = JSON.parse(output);
    if (mode === 'gone' || mode === 'readable') assert.equal(result, false);
    else if (mode === 'task-marker') assert.equal(result, true);
    else {
      assert.equal(result.error, 'unreadable-process');
      assert.equal(result.ambiguous, 1);
      if (mode === 'denied-then-gone') assert.equal(result.diagnostics[0].errno, 'EACCES');
    }
    assert.doesNotMatch(output, /PRIVATE/);
  });
}
