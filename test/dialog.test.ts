import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { SpawnerActions } from '../src/actions.js';
import type { Invoker, Where } from '../src/auth.js';
import { parseCommand } from '../src/commands.js';
import { LocalHost } from '../src/host.js';
import type { ClaudeLauncher } from '../src/launcher.js';
import type { Notifier } from '../src/notifier.js';
import type { Provisioner } from '../src/provision.js';
import { renderHeaders } from '../src/launcher.js';
import { Registry, type BotEntry } from '../src/registry.js';
import type { Tmux } from '../src/tmux.js';
import { TranscriptWatcher } from '../src/transcript-watch.js';
import { testConfig, tmp } from './helpers.js';

const PERMISSION_PANE = [
  '──────────────────────────────', ' Bash command', '   │ rm -rf "$X/build"', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Tab to amend',
].join('\n');
const ASK_PANE = [
  ' ☐ Scope', '', 'How wide?', '', '❯ 1. [ ] Frontend', '  2. [ ] Backend', '  3. Type something.', '  4. Chat about this',
].join('\n');

/** A pane that changes when keys arrive: the dialog closes after the first keystroke. */
class ScriptedTmux {
  panes = new Map<string, string>();
  keys: string[] = [];
  text: string[] = [];
  async hasSession() {
    return true;
  }
  async listSessions() {
    return [];
  }
  async capturePane(n: string) {
    return this.panes.get(n) ?? '';
  }
  async sendKeys(n: string, ...k: string[]) {
    this.keys.push(...k);
    if (k[0] !== '1' || !this.panes.get(n)?.includes('[ ]')) this.panes.set(n, '> working');
  }
  async sendText(_n: string, t: string) {
    this.text.push(t);
  }
}

class Posts implements Notifier {
  out: string[] = [];
  async postHome(_e: unknown, c: string) {
    this.out.push(c);
    return 77;
  }
  async reply() {}
  async dm() {}
}

const home: Where = { kind: 'stream', streamName: 'cc-hands', streamId: 7, topic: 'release' };
const tester: Invoker = { userId: 1, name: 'Tester', kind: 'user' };

function setup() {
  const dir = tmp();
  const cfg = testConfig(dir);
  const registry = new Registry(join(dir, 'r.json'));
  const e: BotEntry = {
    suffix: 'scout', personaName: 'Claude-Code-opus-5-5-scout', botUserId: 100, botEmail: 'b@x', tmuxSession: 'cc-opus-5-5-scout',
    streamName: 'cc-hands', streamId: 7, topic: 'release', handDir: '/x', model: 'claude-opus-5-5', sessionId: 's',
    spawnedBy: { userId: 1, username: 'Tester' }, spawnedAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
    status: 'alive', seedFile: '/x/seed', transcriptOffset: 0,
  };
  registry.add(e);
  const tmux = new ScriptedTmux();
  const posts = new Posts();
  const watcher = new TranscriptWatcher(registry, new LocalHost(), tmux as unknown as Tmux, posts, { agentsHome: dir, projectDir: dir }, () => 'CC Spawner');
  const actions = new SpawnerActions({
    config: cfg, registry, host: new LocalHost(), tmux: tmux as unknown as Tmux, provisioner: {} as Provisioner,
    launcher: {} as ClaudeLauncher, notifier: posts, watcher, groupCheck: async () => false, realm: 'x',
  });
  const run = (text: string, where: Where = home) => actions.run({ cmd: parseCommand(text), body: text, where, invoker: tester });
  return { registry, tmux, posts, watcher, run, e };
}

test('a permission prompt is posted, answered by the topic shortcut, and closed out', async () => {
  const s = setup();
  s.tmux.panes.set(s.e.tmuxSession, PERMISSION_PANE);
  await s.watcher.sweep();
  assert.equal(s.registry.findAlive('scout')!.pendingQuestion?.messageId, '77');
  const r = await s.run('yes');
  assert.match(r.content, /Answer sent/);
  assert.deepEqual(s.tmux.keys, ['1']);
  assert.equal(s.registry.findAlive('scout')!.pendingQuestion?.answeredWith, 'Yes');
  await s.watcher.sweep();
  assert.match(s.posts.out.at(-1)!, /✅ .*resolved — \*\*Yes\*\* sent from Zulip/);
});

test('the shortcut only applies in the blocked hand\'s topic', async () => {
  const s = setup();
  s.tmux.panes.set(s.e.tmuxSession, PERMISSION_PANE);
  await s.watcher.sweep();
  const r = await s.run('yes', { ...home, topic: 'other' });
  assert.match(r.content, /unknown command/);
  assert.deepEqual(s.tmux.keys, []);
});

test('a stale answer is refused when the dialog changed on screen', async () => {
  const s = setup();
  s.tmux.panes.set(s.e.tmuxSession, PERMISSION_PANE);
  await s.watcher.sweep();
  s.tmux.panes.set(s.e.tmuxSession, PERMISSION_PANE.replace('build', 'dist'));
  const r = await s.run('answer scout 1');
  assert.match(r.content, /moved on to a different question/);
  assert.deepEqual(s.tmux.keys, []);
});

test('multi-select answers toggle then Tab; free text goes through the text entry', async () => {
  const s = setup();
  s.tmux.panes.set(s.e.tmuxSession, ASK_PANE);
  await s.watcher.sweep();
  assert.match(s.posts.out.at(-1)!, /How wide\?.*\(pick any\)/s);
  await s.run('answer scout 1,2');
  assert.deepEqual(s.tmux.keys, ['1', '2', 'Tab']);
  s.tmux.keys = [];
  s.tmux.panes.set(s.e.tmuxSession, ASK_PANE);
  await s.run('answer scout text: both, carefully');
  assert.deepEqual(s.tmux.keys, ['3', 'Enter']);
  assert.deepEqual(s.tmux.text, ['both, carefully']);
});

test('press sends named keys and literal text; rescan reports and clears', async () => {
  const s = setup();
  const r = await s.run('press scout esc 2 hello ctrl-c');
  assert.match(r.content, /Sent `Escape` `2` `hello` `C-c`/);
  assert.deepEqual(s.tmux.keys, ['Escape', '2', 'C-c']);
  assert.deepEqual(s.tmux.text, ['hello']);
  s.tmux.panes.set(s.e.tmuxSession, PERMISSION_PANE);
  assert.match((await s.run('rescan')).content, /open permission prompt found/);
  assert.match((await s.run('rescan')).content, /already posted/);
  s.tmux.panes.set(s.e.tmuxSession, '> idle');
  assert.match((await s.run('rescan')).content, /closed it out/);
  assert.match((await s.run('answer scout 1')).content, /no pending question/);
  assert.match((await s.run('answer nobody 1')).content, /No running hand/);
});

test('attribution headers: templates filled, unsafe names refused', () => {
  const req = { personaName: 'Claude-Code-x', spawnedBy: 'Tester\nInjected: 1', streamName: 's', topic: 't' };
  assert.deepEqual(renderHeaders({ 'x-a': '{hand}/{stream}', 'x-b': '{spawnedBy}', 'x-c': '{nope}' }, req), [
    'x-a: Claude-Code-x/s',
    'x-b: Tester?Injected: 1',
    'x-c: {nope}',
  ]);
  assert.throws(() => renderHeaders({ 'bad name': 'v' }, req), /bad header name/);
});

test('press reports the completed prefix and stops after a literal send failure', async () => {
  const s = setup();
  s.tmux.sendText = async (_n, text) => {
    if (text === '--base') throw new Error('tmux send failed');
    s.tmux.text.push(text);
  };
  const r = await s.run('press scout /codex:review space --base space main enter');
  assert.match(r.content, /Could not send `--base`.*tmux rejected key 3/);
  assert.match(r.content, /Sent before failure: `\/codex:review` `Space`/);
  assert.match(r.content, /input may be half-typed/);
  assert.match(r.content, /press scout ctrl-u/);
  assert.match(r.content, /press scout esc/);
  assert.deepEqual(s.tmux.text, ['/codex:review']);
  assert.deepEqual(s.tmux.keys, ['Space']);
});

test('press reports no confirmed keys when the first named key fails', async () => {
  const s = setup();
  s.tmux.sendKeys = async () => { throw new Error('tmux unavailable'); };
  const r = await s.run('press scout enter hello');
  assert.match(r.content, /Could not send `enter`/);
  assert.match(r.content, /Sent before failure: none confirmed/);
  assert.match(r.content, /input may be half-typed/);
  assert.deepEqual(s.tmux.text, []);
});

test('press keeps child_process command and private paths out of its reply', async () => {
  const s = setup();
  const detail = 'Command failed: sudo -n -H -u private-agent -- tmux -S /private/agents/tmux.sock send-keys -t =scout: -l -- --base\nerror connecting to /private/agents/tmux.sock';
  s.tmux.sendText = async () => {
    throw Object.assign(new Error(detail), { code: 1, stderr: 'private stderr', stdout: '' });
  };
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  try {
    const r = await s.run('press scout space --base enter');
    assert.doesNotMatch(r.content, /Command failed|sudo|private-agent|\/private\/|tmux\.sock|send-keys|private stderr/);
    assert.match(r.content, /Could not send `--base`.*tmux rejected key 2/);
    assert.match(r.content, /Sent before failure: `Space`/);
    assert.match(r.content, /input may be half-typed/);
    assert.match(r.content, /press scout ctrl-u/);
    assert.match(r.content, /press scout esc/);
    assert.deepEqual(s.tmux.keys, ['Space']);
    assert.ok(logs.some((line) => line.includes(detail)), 'detailed error stays in internal logs');
    assert.deepEqual(s.posts.out, [], 'internal logging does not post to chat');
  } finally {
    console.log = originalLog;
  }
});
