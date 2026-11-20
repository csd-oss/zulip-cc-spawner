import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { SpawnerActions } from '../src/actions.js';
import type { Invoker, Where } from '../src/auth.js';
import { parseCommand } from '../src/commands.js';
import { captureText, parseDialogPane, type PendingQuestion } from '../src/question.js';
import { LocalHost } from '../src/host.js';
import type { ClaudeLauncher } from '../src/launcher.js';
import type { Notifier } from '../src/notifier.js';
import type { Provisioner } from '../src/provision.js';
import { renderHeaders } from '../src/launcher.js';
import { Registry, type BotEntry } from '../src/registry.js';
import { Tmux } from '../src/tmux.js';
import { HandPaneError, ownPane, TranscriptWatcher, type PaneFit } from '../src/transcript-watch.js';
import { integrationTest, testConfig, tmp } from './helpers.js';

const PERMISSION_PANE = [
  '──────────────────────────────', ' Bash command', '   │ rm -rf "$X/build"', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Tab to amend',
].join('\n');
const ASK_PANE = [
  ' ☐ Scope', '', 'How wide?', '', '❯ 1. [ ] Frontend', '  2. [ ] Backend', '  3. Type something.', '  4. Chat about this',
].join('\n');

const fixture = (version: string, name: string) =>
  readFileSync(new URL(`./fixtures/claude-${version}/permission-${name}.txt`, import.meta.url), 'utf8');
const countdownPane = (capture: string, version = '2.1.323') => fixture(version, `countdown-${capture}`);
/** Real pane + the session's transcript lines at the same moment (fixtures/dialogs/README.txt). */
const live = (name: string) => readFileSync(new URL(`./fixtures/dialogs/${name}`, import.meta.url), 'utf8');
/** A capture as the watcher asks tmux for it — with attributes (`styled-`), where
 *  the fixture set has one; the plain capture otherwise. */
const screen = (name: string, tag: string) =>
  live(existsSync(new URL(`./fixtures/dialogs/${name}.styled-${tag}.txt`, import.meta.url)) ? `${name}.styled-${tag}.txt` : `${name}.pane-${tag}.txt`);

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
  /** What tmux started in the session's panes, by pane id. Unless a test says
   *  otherwise a session is one pane, started for the hand (`hand`, set by
   *  setup), and that pane's id is the session's name: screens and keys are
   *  keyed by that. */
  started: Record<string, string> | undefined;
  hand: { sessionId: string } = { sessionId: 's' };
  /** Panes whose window has synchronize-panes on. */
  synchronized = new Set<string>();
  async sessionPanes(n: string, capture?: string) {
    const panes = Object.entries(this.started ?? { [n]: `claude --session-id '${this.hand.sessionId}'` })
      .map(([id, command]) => ({ id, dead: false, synchronized: this.synchronized.has(id), command }));
    // As tmux: any pane of the server is captured by its id, in this session or not.
    const there = capture !== undefined && (panes.some((pane) => pane.id === capture) || this.panes.has(capture));
    return { panes, ...(there ? { screen: await this.capturePane(capture!) } : {}) };
  }
}

class Posts implements Notifier {
  out: string[] = [];
  fail = false;
  async postHome(_e: unknown, c: string) {
    if (this.fail) return undefined;
    this.out.push(c);
    return 77;
  }
  async reply() {}
  async dm() {}
}

const home: Where = { kind: 'stream', streamName: 'cc-hands', streamId: 7, topic: 'release' };
const tester: Invoker = { userId: 1, name: 'Tester', kind: 'user' };

/** A pane with a size: what it shows depends on how tall it is, as a TUI's
 *  redraw after a resize would have it. */
class SizedTmux extends ScriptedTmux {
  cols = 80;
  resizes: number[] = [];
  refuse = false;
  constructor(public rows: number, private readonly at: (rows: number) => string) {
    super();
  }
  /** Rows of the window that are not this pane's (a pane stacked under it). */
  below = 0;
  /** Panes in the window. */
  windowPanes = 1;
  async paneSize() {
    return { cols: this.cols, rows: this.rows, windowRows: this.rows + this.below, panes: this.windowPanes };
  }
  /** The window is resized, in height only; this pane gets what the other does not hold. */
  async resizeWindowRows(_n: string, rows: number) {
    if (this.refuse) throw new Error('tmux: unknown command: resize-window');
    this.resizes.push(rows - this.below);
    this.rows = rows - this.below;
  }
  async capturePane(n: string) {
    return this.panes.get(n) ?? this.at(this.rows);
  }
}

/** The calls the countdown fixtures ask about (fixtures/claude-*: tick0–2 and
 *  `different`), as lines of a hand's transcript. With them pending those
 *  prompts are tied to their call; without, they are their rows only — and a
 *  prompt under a countdown that nothing ties takes no key. */
const countdownCall = (id: string, dir = 'nonexistent') => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash',
  input: { command: `rm -rf "$(printf %s /tmp/task-40kjf-fixture1/${dir})"`, description: 'Local scratch-only permission prompt probe' } }] } });
const callResult = (id: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] } });
const COUNTDOWN_CALLS = `${countdownCall('toolu_c0')}\n${countdownCall('toolu_c1', 'other-build')}\n`;

/** `again`: the spawner started anew over what an earlier one (`again`) left —
 *  its registry file read back, the same terminal and topic, a new watcher. */
function setup(tmux: ScriptedTmux = new ScriptedTmux(), fit?: PaneFit, again?: { dir: string; posts: Posts }) {
  const dir = again?.dir ?? tmp();
  const cfg = testConfig(dir, { allowedUsers: [1, 9], creatorOnlyControls: true, ownerUserId: 9 });
  const registry = new Registry(join(dir, 'r.json'));
  const fresh: BotEntry = {
    suffix: 'scout', personaName: 'Claude-Code-opus-5-5-scout', botUserId: 100, botEmail: 'b@x', tmuxSession: 'cc-opus-5-5-scout',
    streamName: 'cc-hands', streamId: 7, topic: 'release', handDir: '/x', model: 'claude-opus-5-5', sessionId: 's',
    spawnedBy: { userId: 1, username: 'Tester' }, spawnedAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
    status: 'alive', seedFile: '/x/seed', transcriptOffset: 0,
  };
  if (again) registry.load();
  else registry.add(fresh);
  const e = registry.findAlive('scout')!;
  tmux.hand = e;
  const posts = again?.posts ?? new Posts();
  const host = new LocalHost();
  const watcher = new TranscriptWatcher(registry, host, tmux as unknown as Tmux, posts, { agentsHome: dir, projectDir: dir }, () => 'CC Spawner', fit);
  const actions = new SpawnerActions({
    config: cfg, registry, host: new LocalHost(), tmux: tmux as unknown as Tmux, provisioner: {} as Provisioner,
    launcher: {} as ClaudeLauncher, notifier: posts, watcher, groupCheck: async () => false, realm: 'x',
  });
  const run = (text: string, where: Where = home, invoker = tester) => actions.run({ cmd: parseCommand(text), body: text, where, invoker });
  /** Put `jsonl` where the hand's transcript lives. */
  const transcript = (jsonl: string) => {
    const path = watcher.transcriptPath(e.sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, jsonl);
  };
  /** One live capture on screen, with the transcript as it was at that moment. */
  const show = (name: string, tag: string, transcriptTag?: string) => {
    tmux.panes.set(e.tmuxSession, screen(name, tag));
    transcript(live(`${name}.transcript${transcriptTag ? `-${transcriptTag}` : ''}.jsonl`));
  };
  return { registry, tmux, posts, watcher, actions, run, e, transcript, show, host, dir };
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

// The reported failure: a heredoc command under a ticking countdown. In an
// 80x24 pane 6 heredoc lines push the dialog's top rule off screen (its title
// is then the first row, and known as the title by its attributes: these are
// captures with them); at 26 columns everything wraps.
for (const [name, ticks] of [
  ['heredoc6-2.1.323', ['tick0', 'tick1', 'tick2']],
  ['heredoc6-2.1.306', ['tick0', 'tick1', 'tick2']],
  ['narrow26-2.1.323', ['tick0', 'tick2']],
  ['barewrap38-2.1.323', ['tick0', 'tick2']],
] as const) {
  test(`countdown ticks never repost the prompt, and a later answer reaches it (${name})`, async () => {
    const s = setup();
    s.show(name, ticks[0]);
    await s.watcher.sweep();
    const pending = s.e.pendingQuestion;
    assert.ok(pending?.messageId);
    assert.equal(pending.questions[0].toolUseId, 'toolu_main0');

    for (const tick of ticks.slice(1)) {
      s.show(name, tick);
      await s.watcher.sweep();
      assert.deepEqual(s.e.pendingQuestion, pending);
      assert.match((await s.run('rescan')).content, /already posted/);
    }
    assert.equal(s.posts.out.length, 1);
    // The post shows the dialog as the terminal did when posted: command rows,
    // reason, and the countdown once ("roughly when").
    const q = pending.questions[0];
    assert.ok(s.posts.out[0].includes('\n**Bash command**\n```\n' + q.detail!.trimEnd() + '\n```'));
    assert.match(q.detail!, /nonexistent\)"\n╌+\n │ Dangerous rm operation/);
    assert.match(q.detail!.replace(/\s+/g, ' '), /will automatically (block|deny) this request in 1:58/);
    assert.match(s.posts.out[0], /answer scout <number>/);

    const r = await s.run('answer scout 1'); // at a tick no sweep has seen
    assert.match(r.content, /Answer sent/);
    assert.deepEqual(s.tmux.keys, ['1']); // cursor list: no Enter
    await s.watcher.sweep();
    assert.match(s.posts.out.at(-1)!, /resolved — \*\*Yes\*\* sent from Zulip/);
  });
}

for (const version of ['2.1.323', '2.1.306']) {
  test(`a command whose top is off screen is posted once, as shown, for the terminal — nothing from the transcript (Claude ${version})`, async () => {
    // 400 heredoc lines in 24 rows: the pane starts at "scratch line 390".
    const name = `heredoc400-${version}`;
    const s = setup();
    s.show(name, 'tick0');
    await s.watcher.sweep();
    const pending = s.e.pendingQuestion;
    assert.equal(pending?.questions[0].toolUseId, 'toolu_main0');
    assert.equal(pending?.questions[0].terminalWhy, 'cut');
    const post = s.posts.out[0];
    assert.match(post, /The top of this prompt is off the hand's screen[\s\S]*cannot show the whole request[\s\S]*will not pass on an answer[\s\S]*only the part on screen[\s\S]*requires terminal input/);
    assert.doesNotMatch(post, /answer scout|transcript/);
    assert.match(post, /\n\*\*Permission request\*\*\n```\n │ scratch line 390\n[\s\S]* │ rm -rf [\s\S]*automatically (block|deny) this request in 1:58[\s\S]*```\n\*\*Do you want to proceed\?\*\*\n> 1\. \*\*Yes\*\*\n> 2\. \*\*No\*\*$/);
    assert.doesNotMatch(post, /scratch line (0|1|200|389)\n/); // rows the terminal does not show
    assert.doesNotMatch(post, /cat <<'END'/);

    // A tick: still that one post, and no key for any answer.
    s.show(name, 'tick2');
    await s.watcher.sweep();
    assert.deepEqual(s.e.pendingQuestion, pending);
    assert.match((await s.run('rescan')).content, /already posted.*respond in the terminal/);
    assert.equal(s.posts.out.length, 1);
    assert.match((await s.run('answer scout 1')).content, /Could not deliver the answer.*requires terminal input.*no keys sent/);
    assert.deepEqual(s.tmux.keys, []);
    assert.equal(s.e.pendingQuestion?.answeredWith, undefined);

    // What the hand's transcript says about the rows above the pane changes
    // nothing that is posted: same pane, an edited hidden line, the same post.
    const other = setup();
    other.tmux.panes.set(other.e.tmuxSession, live(`${name}.pane-tick0.txt`));
    other.transcript(live(`${name}.transcript.jsonl`).replace('scratch line 0\\n', 'rm -rf ~ # \\n'));
    await other.watcher.sweep();
    assert.equal(other.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main0');
    assert.equal(other.posts.out[0], post);
    // Without any transcript the same pane is terminal-only just the same.
    const blind = setup();
    blind.tmux.panes.set(blind.e.tmuxSession, live(`${name}.pane-tick0.txt`));
    await blind.watcher.sweep();
    assert.equal(blind.e.pendingQuestion?.questions[0].toolUseId, undefined);
    assert.equal(blind.posts.out[0], post);
    assert.match((await blind.run('answer scout 1')).content, /requires terminal input.*no keys sent/);
    assert.deepEqual(blind.tmux.keys, []);
  });

  test(`of two pending calls the one being asked is posted, not the one still running (Claude ${version})`, async () => {
    // Two `sleep 3` calls in one turn (fixtures/dialogs: pair). The first is
    // posted; it is approved at the terminal and RUNS, still without a result,
    // while "2 of 2" is asked.
    const s = setup();
    const name = `pair-${version}`;
    s.show(name, 'first', 'first');
    await s.watcher.sweep();
    const one = s.e.pendingQuestion;
    assert.equal(one?.questions[0].toolUseId, 'toolu_main0');
    assert.match(s.posts.out[0], /\*\*Bash command 1 of 2\*\*\n```\n First sample\n/);

    s.show(name, 'overlap', 'overlap');
    // An answer to the first post, before any sweep: refused, no key — and
    // (TASK-BYSTH) the request that IS on screen is posted in its place, as
    // its own request, not as the first one "already posted".
    const refused = (await s.run('answer scout 1')).content;
    assert.match(refused, /moved on to a different question/);
    assert.match(refused, /\nNo keys sent\. What its screen shows now is posted in its home topic — answer that post\.$/);
    assert.deepEqual(s.tmux.keys, []);
    assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main1');
    assert.equal(s.posts.out.length, 2);
    assert.match(s.posts.out[1], /\*\*Bash command 2 of 2\*\*\n```\n Second sample\n/);
    assert.match((await s.run('rescan')).content, /already posted/);
    assert.equal(s.posts.out.length, 2);
    // The first call finishes; the second prompt is the same request as before.
    s.show(name, 'second', 'second');
    await s.watcher.sweep();
    assert.match((await s.run('rescan')).content, /already posted/);
    assert.equal(s.posts.out.length, 2);
    assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
    assert.deepEqual(s.tmux.keys, ['2']);
  });

  test(`two pending calls the dialog cannot tell apart: one terminal-only post each, no key (Claude ${version})`, async () => {
    // As on PR #17. (TASK-BYSTH round 1 answered the one on screen; round 2
    // looked to the place in the queue — "1 of 2" — to tell them apart, but
    // that is the TUI's running count of requests settled and open, which
    // starts over when none is open: the same place can come round for the
    // other call. Nothing on screen identifies the request, so no key.)
    const s = setup();
    const name = `twin-${version}`;
    s.show(name, 'first', 'first');
    await s.watcher.sweep();
    assert.match(s.posts.out[0], /2 pending requests of this hand read exactly like this one, and nothing on its screen says which of them is asking[\s\S]*will not pass one on[\s\S]*requires terminal input/);
    assert.doesNotMatch(s.posts.out[0], /answer scout|toolu_/);
    assert.match(s.posts.out[0], /\*\*Bash command 1 of 2\*\*/);
    assert.deepEqual(s.e.pendingQuestion?.questions[0].lookalikes, ['toolu_main0', 'toolu_main1']);
    assert.equal(s.e.pendingQuestion?.questions[0].terminalWhy, 'lookalike');
    await s.watcher.sweep();
    assert.match((await s.run('rescan')).content, /already posted.*respond in the terminal/);
    assert.equal(s.posts.out.length, 1);
    assert.match((await s.run('answer scout 1')).content, /requires terminal input.*no keys sent/);

    // Answered at the terminal; the twin is asked while the first still runs.
    // The refusal posts what is on screen now — which takes no key either.
    s.show(name, 'overlap', 'overlap');
    assert.match((await s.run('answer scout 1')).content, /moved on to a different question[\s\S]*No keys sent\. What its screen shows now is posted in its home topic \(it takes no answer from here — the post says why\)\.$/);
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, 2);
    assert.match(s.posts.out[1], /2 pending requests[\s\S]*\*\*Bash command 2 of 2\*\*/);
    assert.match((await s.run('answer scout 1')).content, /requires terminal input.*no keys sent/);
    assert.deepEqual(s.tmux.keys, []);

    // The first has its result: one call fits, and it can be answered from here.
    s.show(name, 'second', 'second');
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, 3);
    assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main1');
    assert.match(s.posts.out[2], /answer scout <number>/);
    assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
    assert.deepEqual(s.tmux.keys, ['2']);
  });

  test(`an amended prompt takes no bare digit: it is reposted, and answered by leaving its text field first (Claude ${version})`, async () => {
    const s = setup();
    const name = `amend-${version}`;
    s.show(name, 'open');
    await s.watcher.sweep();
    assert.match(s.posts.out[0], /answer scout <number>/);
    // Someone at the terminal pressed Tab: "1. Yes, and tell Claude what to do next".
    s.show(name, 'yes');
    assert.match((await s.run('answer scout 2')).content, /Could not deliver the answer.*moved on to a different question[\s\S]*No keys sent/);
    assert.deepEqual(s.tmux.keys, []);
    // TASK-BYSTH: the refusal posts the prompt as it is now — before, the next
    // sweep did, "for the terminal".
    assert.equal(s.posts.out.length, 2);
    assert.match(s.posts.out[1], /answer scout <number>[\s\S]*switched this prompt to its text field \(Tab\)\. An answer from here switches it back first[\s\S]*> 1\. \*\*Yes, and tell Claude what to do next\*\*\n> 2\. \*\*No\*\*$/);
    await s.watcher.sweep();
    assert.match((await s.run('rescan')).content, /already posted, still waiting \(`answer scout …`\)/);
    assert.equal(s.posts.out.length, 2);

    // The answer: Tab, a look at the screen, and only then the digit.
    const looks: string[] = [];
    s.tmux.sendKeys = async (n: string, ...k: string[]) => {
      s.tmux.keys.push(...k);
      looks.push(s.tmux.panes.get(n)!.match(/❯ \d\. [^\n]*/)?.[0] ?? '(no dialog)');
      if (k[0] === 'Tab') s.tmux.panes.set(n, screen(name, 'open'));
      else s.tmux.panes.set(n, '> working');
    };
    assert.match((await s.run('answer scout 2')).content, /^Answer sent to .* — \*\*No\*\*\. This confirms the key was sent, not the outcome\.$/);
    assert.deepEqual(s.tmux.keys, ['Tab', '2']); // and no Enter
    assert.deepEqual(looks, ['❯ 1. Yes, and tell Claude what to do next', '❯ 1. Yes']); // the digit went to the list
    assert.equal(s.e.pendingQuestion?.answeredWith, 'No');
  });

  test(`after Tab the digit goes out only to the same request, back on its option list (Claude ${version})`, async () => {
    const name = `amend-${version}`;
    for (const [what, afterTab, said] of [
      ['the field stays', screen(name, 'typed'), /sent `Tab`, then stopped — the prompt did not come back as its option list\. The dialog may be half-answered\. What its screen shows now is posted/],
      ['another request is there', screen(name, 'open').replace(/^ printf reviewer$/m, ' printf reviewed'), /sent `Tab`, then stopped — its screen no longer shows the request the answer was for, so nothing more was sent\. The dialog may be half-answered\. What its screen shows now is posted/],
      ['no dialog is there', '> working', /sent `Tab`, then stopped — its screen no longer shows the request the answer was for, so nothing more was sent\. The dialog may be half-answered\. No prompt is on its screen now\.$/],
    ] as const) {
      const s = setup();
      s.show(name, 'yes');
      await s.watcher.sweep();
      assert.equal(s.e.pendingQuestion?.questions[0].entry, 'amend');
      s.tmux.sendKeys = async (n: string, ...k: string[]) => {
        s.tmux.keys.push(...k);
        if (k[0] === 'Tab') s.tmux.panes.set(n, afterTab);
      };
      const r = (await s.run('answer scout 1')).content;
      assert.match(r, /^Only part of the answer reached /, what);
      assert.match(r, said, what);
      assert.doesNotMatch(r, /press|Answer sent|Could not deliver/, what);
      assert.deepEqual(s.tmux.keys, ['Tab'], what); // never the digit
      assert.equal(s.e.pendingQuestion?.answeredWith, undefined, what);
    }
    // esc needs no detour: it cancels the prompt in either state.
    const s = setup();
    s.show(name, 'no');
    await s.watcher.sweep();
    assert.match((await s.run('answer scout esc')).content, /Dismissal sent.*\*\*Esc\*\*/);
    assert.deepEqual(s.tmux.keys, ['Escape']);
  });
}

test('the answer goes to the request that was posted, or nowhere', async () => {
  // Two calls in one message; the first prompt is posted. It was answered in
  // the terminal; the second, same-looking prompt is up. Whether or not the
  // transcript has caught up, the posted answer is refused.
  for (const transcript of ['open', 'after1']) {
    const s = setup();
    s.show('parallel-2.1.323', 'open', 'open');
    await s.watcher.sweep();
    assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main0');
    assert.match(s.posts.out[0], /scratch\/one/);

    s.show('parallel-2.1.323', 'after1', transcript);
    assert.match((await s.run('answer scout 1')).content, /moved on to a different question/);
    assert.deepEqual(s.tmux.keys, []);
    // TASK-BYSTH: the refusal itself posts the second request (before: the next sweep).
    assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main1');
    assert.equal(s.posts.out.length, 2);
    assert.match(s.posts.out[1], /scratch\/two/);
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, 2);
    assert.match((await s.run('answer scout 2')).content, /Answer sent/);
    assert.deepEqual(s.tmux.keys, ['2']);
  }
});

test('an answer sent before the current request was posted is for an earlier one: no key', async () => {
  // TASK-BYSTH. Zulip message ids rise in the order the server took messages
  // in. Two people answer post 77 at once (ids 80, 81) after its prompt gave
  // way to the next: the first is refused and the new request posted (id 90) —
  // the second, written looking at the old post, must not land on the new one.
  const s = setup();
  let id = 77;
  s.posts.postHome = async (_e: unknown, c: string) => {
    s.posts.out.push(c);
    return id;
  };
  const answer = (text: string, messageId: number) => s.actions.run({ cmd: parseCommand(text), body: text, where: home, invoker: tester, messageId });
  s.show('parallel-2.1.323', 'open', 'open');
  await s.watcher.sweep();
  s.show('parallel-2.1.323', 'after1', 'after1');
  id = 90;
  assert.match((await answer('answer scout 1', 80)).content, /moved on to a different question[\s\S]*What its screen shows now is posted/);
  assert.equal(s.e.pendingQuestion?.messageId, '90');
  const late = (await answer('answer scout 1', 81)).content;
  assert.match(late, /^That answer was sent before .*current request was posted, so it was for an earlier one — no keys sent\./);
  assert.deepEqual(s.tmux.keys, []);
  // Sent after it: an answer to it. (The topic shortcut is the same command.)
  assert.match((await answer('2', 91)).content, /Answer sent.*\*\*No\*\*/);
  assert.deepEqual(s.tmux.keys, ['2']);
});

test('a re-asked identical command is a new request, not the one that was posted', async () => {
  const s = setup();
  s.show('heredoc6-2.1.323', 'tick0');
  await s.watcher.sweep();
  const old = s.e.pendingQuestion;
  // Blocked by the countdown, then asked again: the pane is the same to the
  // character (tick2 of the same capture), only the transcript tells them apart.
  const asked = live('heredoc6-2.1.323.transcript.jsonl');
  const use = asked.trimEnd().split('\n').at(-1)!;
  const result = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_main0', is_error: true, content: 'blocked' }] } });
  s.transcript(`${asked}${result}\n${use.replaceAll('toolu_main0', 'toolu_again')}\n`);
  s.tmux.panes.set(s.e.tmuxSession, screen('heredoc6-2.1.323', 'tick2'));

  assert.match((await s.run('answer scout 1')).content, /moved on to a different question/);
  assert.deepEqual(s.tmux.keys, []);
  await s.watcher.sweep();
  assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_again');
  assert.notEqual(s.e.pendingQuestion?.sig, old?.sig);
  assert.equal(s.posts.out.filter((post) => post.startsWith('🔐')).length, 2);
});

test('a prompt seen before its transcript line is looked at once more, then posted once', async () => {
  const s = setup();
  // The dialog can be on screen ~50 ms before its tool_use line is written.
  s.transcript(live('heredoc6-2.1.323.transcript.jsonl').split('\n')[0] + '\n');
  s.tmux.panes.set(s.e.tmuxSession, screen('heredoc6-2.1.323', 'tick0'));
  let captures = 0;
  const capture = s.tmux.capturePane.bind(s.tmux);
  s.tmux.capturePane = async (n: string) => {
    if (++captures === 2) s.show('heredoc6-2.1.323', 'tick1');
    return capture(n);
  };
  await s.watcher.sweep();
  // The sweep's own look, one after each of the two transcript reads.
  assert.equal(captures, 3);
  assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main0');
  s.show('heredoc6-2.1.323', 'tick2');
  await s.watcher.sweep();
  assert.equal(s.posts.out.length, 1);
});

test('a transcript that cannot be read leaves a posted prompt alone: no repost, no keys', async () => {
  const s = setup();
  s.show('heredoc6-2.1.323', 'tick0');
  await s.watcher.sweep();
  const pending = s.e.pendingQuestion;
  const size = s.host.size.bind(s.host);
  s.host.size = async () => {
    throw new Error('sudo: a password is required');
  };
  s.show('heredoc6-2.1.323', 'tick1');
  await s.watcher.sweep();
  assert.deepEqual(s.e.pendingQuestion, pending);
  assert.equal(s.posts.out.length, 1);
  assert.match((await s.run('rescan')).content, /could not read its screen \(could not read its transcript/);
  assert.match((await s.run('answer scout 1')).content, /Could not deliver the answer.*could not read its transcript/);
  assert.deepEqual(s.tmux.keys, []);
  s.host.size = size;
  s.show('heredoc6-2.1.323', 'tick2');
  assert.match((await s.run('answer scout 1')).content, /Answer sent/);
  assert.deepEqual(s.tmux.keys, ['1']);

  // Never readable, nothing posted yet: the prompt is still posted, by its
  // rows — and, being under a countdown with no call to tie it to, takes no key.
  const blind = setup();
  blind.show('heredoc6-2.1.323', 'tick0');
  blind.host.size = s.host.size = async () => {
    throw new Error('sudo: a password is required');
  };
  await blind.watcher.sweep();
  assert.equal(blind.posts.out.length, 1);
  assert.equal(blind.e.pendingQuestion?.questions[0].toolUseId, undefined);
  assert.equal(blind.e.pendingQuestion?.questions[0].terminalWhy, 'unbound');
  assert.match(blind.posts.out[0], /No pending call of the hand identifies this request [^\n]*, and it is under Claude Code's countdown/);
  assert.doesNotMatch(blind.posts.out[0], /answer scout/);
  assert.match((await blind.run('answer scout 1')).content, /requires terminal input — no keys sent/);
  assert.deepEqual(blind.tmux.keys, []);
});

for (const version of ['2.1.306', '2.1.323']) {
  test(`with no transcript a prompt under a countdown is posted once and takes no key: its rows could be the next request's (Claude ${version})`, async () => {
    // E.g. the hand's session id moved on. Nothing but the rows on screen says
    // which request this is, and under a countdown they change every second.
    // PR #17 refused an answer after a tick and reposted the prompt per tick.
    // TASK-BYSTH round 1 held an answer to the time the countdown ends instead
    // — but a request asked right after another ends a moment after it (review
    // controls clock-*: 130 ms). So: one post through the ticks, which says why
    // it takes no answer; the countdown only ever tells a NEW request.
    const s = setup();
    s.tmux.panes.set(s.e.tmuxSession, countdownPane('tick0', version));
    await s.watcher.sweep();
    const q = s.e.pendingQuestion!.questions[0];
    assert.equal(q.toolUseId, undefined);
    assert.equal(q.terminalWhy, 'unbound');
    assert.equal(q.entry, 'list');
    assert.match(s.posts.out[0], /No pending call of the hand identifies this request \(I can tie only its own Bash requests to one, and need its transcript for that\), and it is under Claude Code's countdown: a request asked after it that reads the same could not be told from this one, so I will not pass on an answer\. This permission prompt requires terminal input\. `@\*\*CC Spawner\*\* show scout` reads its screen again\./);
    assert.doesNotMatch(s.posts.out[0], /answer scout|⏳|\bpress\b/);
    assert.match(s.posts.out[0], /nonexistent[\s\S]*Dangerous rm operation[\s\S]*automatically (block|deny) this request in 1:59/);
    for (const tick of ['tick1', 'tick2']) {
      s.tmux.panes.set(s.e.tmuxSession, countdownPane(tick, version));
      await s.watcher.sweep();
      assert.match((await s.run('rescan')).content, /already posted, still waiting \(respond in the terminal\)/);
      assert.equal(s.posts.out.length, 1);
      // Not at the tick it was posted at, not at any other, and no `esc` either.
      for (const answer of ['answer scout 1', 'answer scout 2', 'answer scout esc']) {
        assert.match((await s.run(answer)).content, /Could not deliver the answer.*requires terminal input — no keys sent/);
      }
    }
    s.tmux.panes.set(s.e.tmuxSession, countdownPane('tick0', version));
    assert.match((await s.run('answer scout 1')).content, /requires terminal input — no keys sent/);
    assert.deepEqual(s.tmux.keys, []);
    assert.equal(s.e.pendingQuestion?.answered, undefined);

    // The same rows under a countdown that ends later: the request was blocked
    // and asked again (here: the post is 20 s old, the clock is not). That one
    // gets a post of its own.
    const stale = structuredClone(s.e.pendingQuestion!);
    stale.questions[0].expiry!.at! -= 20_000;
    s.registry.update(s.e, { pendingQuestion: stale });
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, 2);
    assert.deepEqual(s.tmux.keys, []);
  });

  test(`the older live countdown captures are tied once their call is in the transcript (Claude ${version})`, async () => {
    // 100x36 (2.1.323) / 80-column (2.1.306) panes with the whole dialog on screen.
    const s = setup();
    const use = { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'rm -rf "$(printf %s /tmp/task-40kjf-fixture1/nonexistent)"', description: 'Local scratch-only permission prompt probe' } };
    s.transcript(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [use] } }) + '\n');
    for (const tick of ['tick0', 'tick1', 'tick2']) {
      s.tmux.panes.set(s.e.tmuxSession, countdownPane(tick, version));
      await s.watcher.sweep();
    }
    assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_x');
    assert.equal(s.posts.out.length, 1);
    assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
    assert.deepEqual(s.tmux.keys, ['2']);
  });
}

test('the screen is looked at after the transcript is read: a prompt that changed meanwhile gets no key', async () => {
  // Two pending calls with different commands; the first prompt is posted.
  const s = setup();
  s.show('parallel-2.1.323', 'open', 'open');
  await s.watcher.sweep();
  assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main0');

  // While the answer path reads the transcript, the first prompt is answered
  // at the terminal and the second comes up. Both calls are still pending.
  let captures = 0;
  const capture = s.tmux.capturePane.bind(s.tmux);
  s.tmux.capturePane = async (n: string) => {
    captures++;
    return capture(n);
  };
  const readFrom = s.host.readFrom.bind(s.host);
  let during: (() => void) | undefined = () => s.tmux.panes.set(s.e.tmuxSession, live('parallel-2.1.323.pane-after1.txt'));
  s.host.readFrom = async (path, from) => {
    const bytes = await readFrom(path, from);
    during?.();
    during = undefined;
    return bytes;
  };
  const r = await s.run('answer scout 1');
  assert.match(r.content, /Could not deliver the answer.*moved on to a different question/);
  assert.deepEqual(s.tmux.keys, []);
  assert.equal(captures, 2); // before the read, and after it
  // The same holds for what a sweep posts: the request on screen after its read.
  s.show('parallel-2.1.323', 'open', 'open');
  s.registry.update(s.e, { pendingQuestion: undefined });
  during = () => s.tmux.panes.set(s.e.tmuxSession, live('parallel-2.1.323.pane-after1.txt'));
  await s.watcher.sweep();
  assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main1');
  assert.match(s.posts.out.at(-1)!, /scratch\/two/);

  // A prompt that closed during the read is not answered either.
  during = () => s.tmux.panes.set(s.e.tmuxSession, '> working');
  assert.match((await s.run('answer scout 1')).content, /Could not deliver the answer.*no question dialog is on screen/);
  assert.deepEqual(s.tmux.keys, []);
});

test('once the key is sent, failing to look afterwards is a note on a sent answer, not a failed delivery', async () => {
  for (const failing of ['transcript', 'screen'] as const) {
    const s = setup();
    s.show('heredoc6-2.1.323', 'tick0');
    await s.watcher.sweep();
    assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main0');
    let sent = false;
    s.tmux.sendKeys = async (_n, ...k) => {
      s.tmux.keys.push(...k); // the dialog stays up: the next prompt, or a slow terminal
      sent = true;
    };
    const size = s.host.size.bind(s.host);
    const capture = s.tmux.capturePane.bind(s.tmux);
    if (failing === 'transcript') {
      s.host.size = async (path) => {
        if (sent) throw new Error('sudo: a password is required');
        return size(path);
      };
    } else {
      s.tmux.capturePane = async (n: string) => {
        if (sent) throw new Error('tmux: server busy');
        return capture(n);
      };
    }
    const r = await s.run('answer scout 2');
    assert.deepEqual(s.tmux.keys, ['2']);
    assert.match(r.content, /^Answer sent to \*\*[^*]+\*\* — \*\*No\*\*\. This confirms the key was sent, not the outcome\.\nℹ️ I could not look at its screen afterwards \(.*\) — `rescan` to see what is open now\.$/);
    assert.doesNotMatch(r.content, /Could not deliver/);
    assert.equal(s.e.pendingQuestion?.answeredWith, 'No'); // the receipt is kept
    // Before any key, the same failure is still a refusal with nothing sent.
    const before = setup();
    before.show('heredoc6-2.1.323', 'tick0');
    await before.watcher.sweep();
    if (failing === 'transcript') before.host.size = async () => { throw new Error('sudo: a password is required'); };
    else before.tmux.capturePane = async () => { throw new Error('tmux: server busy'); };
    assert.match((await before.run('answer scout 2')).content, /Could not deliver the answer/);
    assert.deepEqual(before.tmux.keys, []);
    assert.equal(before.e.pendingQuestion?.answeredWith, undefined);
  }
});

test('clipped untimed requests whose visible indentation differs get separate terminal-only posts', async () => {
  // Real 80x24 captures of consecutive MCP requests. The only visible change
  // is that record() moves inside the if block; neither prompt shows a title.
  const s = setup();
  const name = 'indent-2.1.323';
  for (const [index, tag, row] of [
    [0, 'first', '   │ record()'],
    [1, 'second', '   │     record()'],
  ] as const) {
    s.tmux.panes.set(s.e.tmuxSession, screen(name, tag));
    if (index === 0) await s.watcher.sweep();
    else assert.match((await s.run('rescan')).content, /open permission prompt found, posted/);
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, index + 1);
    const q = s.e.pendingQuestion?.questions[0];
    assert.equal(q?.terminalWhy, 'cut');
    assert.equal(q.toolUseId, undefined);
    assert.ok(s.posts.out[index].includes('\n' + row + '\n'));
    assert.match(s.posts.out[index], /requires terminal input/);
    assert.doesNotMatch(s.posts.out[index], /answer scout/);
    assert.match((await s.run('answer scout 1')).content, /requires terminal input — no keys sent/);
  }
  assert.deepEqual(s.tmux.keys, []);
});

test('a clipped and untied request with a wrapped expiry notice gets one terminal-only post across ticks', async () => {
  const s = setup();
  // At 40x30 the body is visible but the title is not. No transcript is available.
  const pane = screen('wrapped40-2.1.323', 'tick0');
  s.tmux.panes.set(s.e.tmuxSession, pane);
  await s.watcher.sweep();
  const pending = s.e.pendingQuestion;
  assert.equal(pending?.questions[0].terminalWhy, 'cut');
  assert.equal(pending.questions[0].toolUseId, undefined);
  assert.match(s.posts.out[0], /requires terminal input[\s\S]*echo word0[\s\S]*automatically block\n this request in 1:58/);
  s.tmux.panes.set(s.e.tmuxSession, pane.replace('1:58,', '1:56,'));
  await s.watcher.sweep();
  assert.deepEqual(s.e.pendingQuestion, pending);
  assert.match((await s.run('rescan')).content, /already posted, still waiting \(respond in the terminal\)/);
  assert.equal(s.posts.out.length, 1);
  assert.match((await s.run('answer scout 2')).content, /requires terminal input — no keys sent/);
  assert.deepEqual(s.tmux.keys, []);
});

for (const version of ['2.1.323', '2.1.306']) {
  test(`a countdown notice clipped at the pane edge gets one terminal-only post (Claude ${version})`, async () => {
    const s = setup();
    const name = `clipped-notice26-${version}`;
    s.transcript(live(`short10-${version}.transcript.jsonl`)); // a pending Bash request can't bind without the box
    s.tmux.panes.set(s.e.tmuxSession, screen(name, 'tick0'));
    await s.watcher.sweep();
    const pending = s.e.pendingQuestion;
    assert.equal(pending?.questions[0].terminalWhy, 'cut');
    assert.equal(pending.questions[0].toolUseId, undefined);
    assert.match(s.posts.out[0], /requires terminal input[\s\S]*automatically (block|deny) this\n request in 1:57,/);
    s.tmux.panes.set(s.e.tmuxSession, screen(name, 'tick1'));
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, 1);
    assert.deepEqual(s.e.pendingQuestion, pending);
    assert.match((await s.run('rescan')).content, /already posted, still waiting \(respond in the terminal\)/);
    assert.match((await s.run('answer scout 2')).content, /requires terminal input — no keys sent/);
    assert.deepEqual(s.tmux.keys, []);
  });
}

test('clipped request text that only resembles an expiry notice still gets two posts when it changes', async () => {
  const detail = screen('clipped-notice26-2.1.323', 'tick0');
  for (const nonNotice of [
    detail.replace(/^ automatically block this\n request in /, ' Job starts at '),
    ' Preview details\n' + detail, // a fragment only qualifies at the pane edge
    detail.replace('avoid holding up an', 'avoid waking up an'),
    detail.replace('automatically block', 'automatically deny'), // mismatched notice wording
  ]) {
    const s = setup();
    s.tmux.panes.set(s.e.tmuxSession, nonNotice);
    await s.watcher.sweep();
    assert.equal(s.e.pendingQuestion?.questions[0].terminalWhy, 'cut');
    s.tmux.panes.set(s.e.tmuxSession, nonNotice.replace('1:57,', '1:37,'));
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, 2, nonNotice);
    assert.match(s.posts.out[1], /1:37,/);
    assert.match((await s.run('answer scout 2')).content, /requires terminal input — no keys sent/);
    assert.deepEqual(s.tmux.keys, []);
  }
});

// ── Round 6: no answer unless the pane positively shows what is being approved ──

for (const version of ['2.1.323', '2.1.306']) {
  test(`two different requests behind one short screen: one post for the terminal, no key to either (Claude ${version})`, async () => {
    // The round-5 witness, at 26x12: "First sample / printf first" is asked;
    // nothing of it but the permission-rule note and the options is on screen.
    const s = setup();
    s.show(`boxless-${version}`, 'first', 'first');
    await s.watcher.sweep();
    const posted = s.e.pendingQuestion!;
    assert.equal(posted.questions[0].terminalWhy, 'cut');
    assert.equal(posted.questions[0].toolUseId, undefined);
    assert.match(s.posts.out[0], /The top of this prompt is off the hand's screen[\s\S]*will not pass on an answer/);
    assert.doesNotMatch(s.posts.out[0], /answer scout|<number>|printf|sample/);
    // It is acknowledged at the terminal; "Second sample / printf second" is
    // asked — the same screen to the character.
    s.show(`boxless-${version}`, 'second', 'second');
    const scan = (await s.run('rescan')).content;
    assert.match(scan, /already posted, still waiting \(respond in the terminal\)/);
    assert.doesNotMatch(scan, /answer scout/);
    for (const spec of ['answer scout 1', 'answer scout 2', 'answer scout yes', '1']) {
      assert.match((await s.run(spec)).content, /requires terminal input — no keys sent/, spec);
    }
    assert.deepEqual(s.tmux.keys, []);
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, 1);
    assert.equal(s.e.pendingQuestion?.answeredWith, undefined);
    // Made tall enough, the pane shows the second request: a new post, answerable, its own.
    s.tmux.panes.set(s.e.tmuxSession, live(`boxless-${version}.pane-second-full.txt`));
    assert.match((await s.run('answer scout 1')).content, /moved on to a different question/);
    assert.deepEqual(s.tmux.keys, []);
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, 2);
    assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main1');
    assert.match(s.posts.out[1], /answer scout <number>[\s\S]*Second sample[\s\S]*printf second/);
    assert.match((await s.run('answer scout 2')).content, /Answer sent/);
    assert.deepEqual(s.tmux.keys, ['2']);
  });

  test(`a countdown prompt with none of its request on screen is posted once for the terminal, not once per tick (Claude ${version})`, async () => {
    for (const transcript of [true, false]) {
      const s = setup();
      s.show(`short10-${version}`, 'tick0');
      if (!transcript) s.e.sessionId = 'no-such-session';
      await s.watcher.sweep();
      assert.equal(s.e.pendingQuestion?.questions[0].terminalWhy, 'cut');
      assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, undefined);
      assert.match(s.posts.out[0], /will not pass on an answer[\s\S]*automatically (block|deny) this request in 1:57/);
      assert.doesNotMatch(s.posts.out[0], /answer scout/);
      s.tmux.panes.set(s.e.tmuxSession, screen(`short10-${version}`, 'tick1'));
      await s.watcher.sweep();
      assert.match((await s.run('rescan')).content, /already posted, still waiting \(respond in the terminal\)/);
      assert.equal(s.posts.out.length, 1);
      assert.match((await s.run('answer scout 2')).content, /requires terminal input — no keys sent/);
      assert.deepEqual(s.tmux.keys, []);
      // It expires, or is answered at the terminal: closed out as usual.
      s.tmux.panes.set(s.e.tmuxSession, '> working');
      await s.watcher.sweep();
      assert.match(s.posts.out.at(-1)!, /permission prompt \(Permission request\) is no longer on screen/);
      assert.equal(s.e.pendingQuestion, undefined);
    }
  });

  test(`a description that reads "Bash command" does not stand in for a title that is off screen (Claude ${version})`, async () => {
    // The round-5 witness: a subagent's request, description "Bash command",
    // the pane one row too short for its title. Nothing of the hand's is pending.
    const s = setup();
    s.show(`titlelike-${version}`, 'description-first');
    await s.watcher.sweep();
    assert.equal(s.e.pendingQuestion?.questions[0].terminalWhy, 'cut');
    assert.match(s.posts.out[0], /will not pass on an answer[\s\S]*\*\*Permission request\*\*\n```\n Bash command\n╌+\n rm -rf /);
    assert.doesNotMatch(s.posts.out[0], /answer scout/);
    assert.match((await s.run('rescan')).content, /still waiting \(respond in the terminal\)/);
    assert.match((await s.run('answer scout 1')).content, /requires terminal input — no keys sent/);
    assert.deepEqual(s.tmux.keys, []);
    // One row taller, the title is on screen and says whose request it is: answerable, as that.
    s.show(`titlelike-${version}`, 'title-first');
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, 2);
    assert.match(s.posts.out[1], /answer scout <number>[\s\S]*\*\*Bash command · from the general-purpose agent\*\*\n```\n Bash command\n╌/);
    assert.match((await s.run('answer scout 2')).content, /Answer sent/);
    assert.deepEqual(s.tmux.keys, ['2']);
  });

  test(`a description that mentions "· from" neither reposts nor stales its own request (Claude ${version})`, async () => {
    const s = setup();
    s.show(`descfrom-${version}`, 'tick0');
    await s.watcher.sweep();
    assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main0');
    s.show(`descfrom-${version}`, 'tick1');
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, 1);
    assert.match((await s.run('answer scout 2')).content, /Answer sent/);
    assert.deepEqual(s.tmux.keys, ['2']);
  });
}

test('once the key is sent, failing to record it is reported as that — sent, and not to be sent again', async () => {
  for (const [command, key, label] of [['answer scout 2', '2', 'No'], ['answer scout esc', 'Escape', 'Esc'], ['press scout 2', '2', 'keys 2']] as const) {
    const s = setup();
    s.show('heredoc6-2.1.323', 'tick0');
    await s.watcher.sweep();
    const save = s.registry.save.bind(s.registry);
    let failed = 0;
    s.registry.save = () => {
      if (s.tmux.keys.length) {
        failed++;
        throw new Error("ENOSPC: no space left on device, open 'r.json.tmp'");
      }
      save();
    };
    const r = (await s.run(command)).content;
    s.registry.save = save;
    assert.deepEqual(s.tmux.keys, [key]);
    assert.equal(failed, 1);
    assert.doesNotMatch(r, /Could not deliver|try again|retry/i);
    assert.match(r, command.startsWith('press')
      ? /^Sent `2` to \*\*[^*]+\*\* — `peek scout` to see what it did\.\n⚠️ It \*\*was sent\*\* — do not send it again\. I could not save my record of it \(ENOSPC/
      : /^(Answer|Dismissal) sent to \*\*[^*]+\*\* — \*\*(No|Esc)\*\*\. This confirms the key was sent, not the outcome\.\n⚠️ It \*\*was sent\*\* — do not send it again\. I could not save my record of it \(ENOSPC/);
    // What was sent is still known here, and the close-out says it.
    assert.equal(s.e.pendingQuestion?.answeredWith, label);
    await s.watcher.sweep();
    assert.match(s.posts.out.at(-1)!, new RegExp(`is resolved — \\*\\*${label}\\*\\* sent from Zulip`));
    assert.equal(s.e.pendingQuestion, undefined);
  }
  // Before any key the same failure sends nothing and says so.
  const s = setup();
  s.show('heredoc6-2.1.323', 'tick0');
  await s.watcher.sweep();
  s.tmux.sendKeys = async () => {
    throw new Error('tmux: no server');
  };
  const failed = (await s.run('answer scout 2')).content;
  assert.match(failed, /^Could not deliver the answer/);
  // TASK-BYSTH round 2: tmux failing on the very first key does not say the key
  // stayed here. The post it was sent on takes no further answer, the reply
  // says so, and what is on screen is posted anew — so a retry is not met with
  // "already had an answer" out of the blue.
  assert.match(failed, /^Could not deliver the answer to .*: tmux: no server\. The key may still have reached its terminal, so the post it was sent on takes no further answer\. What its screen shows now is posted in its home topic — answer that post\.$/);
  assert.equal(s.posts.out.length, 2);
  assert.equal(s.e.pendingQuestion?.answered, undefined); // the new post
  s.tmux.sendKeys = async (_n: string, ...k: string[]) => void s.tmux.keys.push(...k);
  assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
  assert.deepEqual(s.tmux.keys, ['2']);
});

test('an answer cut short by tmux says which keys went, and does not claim either outcome', async () => {
  const s = setup();
  s.tmux.panes.set(s.e.tmuxSession, ASK_PANE);
  await s.watcher.sweep();
  s.tmux.sendKeys = async (_n, ...k) => {
    if (k[0] === '2') throw new Error('tmux send failed');
    s.tmux.keys.push(...k);
  };
  const r = await s.run('answer scout 1,2');
  assert.deepEqual(s.tmux.keys, ['1']);
  assert.match(r.content, /^Only part of the answer reached .*: sent `1`, then stopped — tmux failed \(tmux send failed\)\. The dialog may be half-answered\./);
  assert.doesNotMatch(r.content, /Could not deliver|Answer sent/);
  // TASK-BYSTH: no raw-key advice; the reply says what the screen shows now.
  assert.doesNotMatch(r.content, /press/);
  assert.match(r.content, /Its screen still shows the request as it was posted\.$/);
});

test('a subagent\'s prompt (own title and footer, tool_use in another file) is bridged by its rows', async () => {
  const s = setup();
  s.show('subagent-2.1.323', 'open');
  await s.watcher.sweep();
  assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, undefined);
  assert.match(s.posts.out[0], /\*\*Bash command · from the general-purpose agent\*\*/);
  assert.match(s.posts.out[0], /answer scout <number>/);
  await s.watcher.sweep();
  assert.match((await s.run('rescan')).content, /already posted/);
  assert.equal(s.posts.out.length, 1);
  assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
  assert.deepEqual(s.tmux.keys, ['2']);
});

test('dialogs whose footer wraps onto the last row are posted and answered (38 and 26 columns)', async () => {
  const ask = setup();
  ask.tmux.panes.set(ask.e.tmuxSession, live('ask-wrapped38-2.1.323.pane.txt'));
  await ask.watcher.sweep();
  assert.match(ask.posts.out[0], /^❓[\s\S]*Which fruit should I use\?[\s\S]*> 2\. \*\*Banana\*\*/);
  assert.match((await ask.run('rescan')).content, /question already posted/);
  assert.match((await ask.run('answer scout 2')).content, /Answer sent/);
  assert.deepEqual(ask.tmux.keys, ['2']);

  const perm = setup();
  perm.tmux.panes.set(perm.e.tmuxSession, live('untimed-wrapped26-2.1.323.pane.txt'));
  await perm.watcher.sweep();
  assert.match(perm.posts.out[0], /^🔐[\s\S]*answer scout <number>[\s\S]*printf reviewer/);
  assert.match((await perm.run('rescan')).content, /permission prompt already posted/);
  assert.match((await perm.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
  assert.deepEqual(perm.tmux.keys, ['2']);
});

for (const name of ['ax-2.1.323', 'ax-2.1.306']) {
  test(`a screen-reader prompt is posted once, as one that takes its answer in steps (${name})`, async () => {
    // TASK-BYSTH. Before: posted for the terminal, no keys.
    const s = setup();
    s.show(name, 'tick0');
    await s.watcher.sweep();
    assert.match(s.posts.out[0], /answer scout <number>[\s\S]*This hand runs the screen-reader layout: I type the number, check that it shows, then send Enter\.\n/);
    assert.doesNotMatch(s.posts.out[0], /requires terminal input/);
    assert.match(s.posts.out[0], /about 2 minutes/);
    assert.match(s.posts.out[0], /\n⏳ Claude Code refuses this request by itself in about 2 minutes\. An answer after that is not passed on\.$/);
    // Its coarse clock moves on (synthetic edit of the captured notice): still that one post.
    s.tmux.panes.set(s.e.tmuxSession, live(`${name}.pane-tick0.txt`).replace('about 2 minutes', 'about 1 minute'));
    await s.watcher.sweep();
    assert.match((await s.run('rescan')).content, /already posted, still waiting \(`answer scout …`\)/);
    assert.equal(s.posts.out.length, 1);
    // A digit that does not show in its input field is not submitted.
    s.tmux.sendKeys = async (_n: string, ...k: string[]) => void s.tmux.keys.push(...k);
    const r = await s.run('answer scout 2');
    assert.match(r.content, /^Only part of the answer reached .*: sent `2`, then stopped — its input field does not show `2`, so Enter was not sent\./);
    assert.deepEqual(s.tmux.keys, ['2']);
    assert.equal(s.e.pendingQuestion?.answeredWith, undefined);
  });
}

for (const version of ['2.1.323', '2.1.306']) {
  /** Live captures of one screen-reader prompt: as asked, with `2` typed, with
   *  that deleted again, with `12` typed (fixtures/dialogs: reader). The TUI
   *  drops the expiry notice at the first key. */
  const name = `reader-${version}`;
  const reader = (tag: string) => live(`${name}.pane-${tag}.txt`);
  /** The TUI's side of it: digits and backspaces edit the field, Enter submits. */
  const typing = (s: ReturnType<typeof setup>, shows: (field: string) => string = (field) => (field === '' ? reader('cleared') : field === '12' ? reader('typed12') : reader('typed').replace('to cancel: 2\n', `to cancel: ${field}\n`))) => {
    let field = s.tmux.panes.get(s.e.tmuxSession)!.match(/to cancel: ?(\d*)\n/)?.[1] ?? '';
    s.tmux.sendKeys = async (n: string, ...k: string[]) => {
      s.tmux.keys.push(...k);
      for (const key of k) {
        if (key === 'Enter' || key === 'Escape') return void s.tmux.panes.set(n, '> working');
        field = key === 'BSpace' ? field.slice(0, -1) : field + key;
      }
      s.tmux.panes.set(n, shows(field));
    };
  };

  test(`screen-reader layout: the digit is typed, seen in its field, and only then submitted (Claude ${version})`, async () => {
    const s = setup();
    s.show(name, 'open');
    await s.watcher.sweep();
    const q = s.e.pendingQuestion!.questions[0];
    assert.equal(q.entry, 'reader');
    assert.equal(q.toolUseId, 'toolu_main0');
    assert.equal(q.requiresTerminal, undefined);
    assert.match(s.posts.out[0], /\*\*Bash command\*\*\n```\n> Local scratch-only permission prompt probe\n> rm -rf "\$\(printf %s \/tmp\/scratch\/nonexistent\)"\n/);
    typing(s);
    assert.match((await s.run('answer scout 2')).content, /^Answer sent to .* — \*\*No\*\*\. This confirms the key was sent, not the outcome\.$/);
    assert.deepEqual(s.tmux.keys, ['2', 'Enter']);
    await s.watcher.sweep();
    assert.match(s.posts.out.at(-1)!, /resolved — \*\*No\*\* sent from Zulip/);
  });

  test(`screen-reader layout: Enter goes only to the same request showing just that digit (Claude ${version})`, async () => {
    for (const [what, shows] of [
      ['another digit is in the field', () => reader('typed12')],
      ['another request is there', () => reader('typed').replaceAll('/tmp/scratch/nonexistent', '/tmp/scratch/other')],
      ['its layout changed', () => PERMISSION_PANE],
      ['no dialog is there', () => '> working'],
    ] as const) {
      const s = setup();
      s.show(name, 'open');
      await s.watcher.sweep();
      typing(s, shows);
      const r = (await s.run('answer scout 2')).content;
      const why = what === 'another digit is in the field' ? 'its input field does not show `2`, so Enter was not sent' : 'its screen no longer shows the request the answer was for, so nothing more was sent';
      assert.ok(r.startsWith(`Only part of the answer reached **${s.e.personaName}**: sent \`2\`, then stopped — ${why}. The dialog may be half-answered.`), `${what}: ${r}`);
      assert.deepEqual(s.tmux.keys, ['2'], what); // never Enter
      assert.doesNotMatch(r, /press|Answer sent/, what);
      assert.equal(s.e.pendingQuestion?.answeredWith, undefined, what);
    }
  });

  test(`screen-reader layout: what is already typed there is cleared, and seen to be, first (Claude ${version})`, async () => {
    const s = setup();
    s.show(name, 'typed12');
    await s.watcher.sweep();
    assert.equal(s.e.pendingQuestion?.questions[0].typed, '12');
    assert.match(s.posts.out[0], /Its input field holds `12` now; I clear that first\./);
    typing(s);
    assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
    assert.deepEqual(s.tmux.keys, ['BSpace', 'BSpace', '2', 'Enter']);

    // The field does not read one character shorter after a backspace: no
    // second one, and nothing is typed into it.
    const stuck = setup();
    stuck.show(name, 'typed12');
    await stuck.watcher.sweep();
    typing(stuck, () => reader('typed'));
    const r = (await stuck.run('answer scout 1')).content;
    assert.match(r, /sent `BSpace`, then stopped — its input field does not read `1` after my backspace\./);
    assert.deepEqual(stuck.tmux.keys, ['BSpace']);
    // What the screen shows now (`2` in the field) is posted as the request to answer.
    assert.match(stuck.posts.out.at(-1)!, /Its input field holds `2` now; I clear that first\./);

    // …or does not come back empty after the last one.
    const last = setup();
    last.show(name, 'typed');
    await last.watcher.sweep();
    typing(last, () => reader('typed'));
    assert.match((await last.run('answer scout 1')).content, /sent `BSpace`, then stopped — its input field did not come back empty\./);
    assert.deepEqual(last.tmux.keys, ['BSpace']);
  });

  // Review of e90e6be (probes2/erase): the field held `12`; after the bot's
  // first backspace someone at the terminal submitted the `1` that was left,
  // and typed a digit into the request that came up next. The second backspace
  // of a batch erased that request's digit.
  test(`screen-reader layout: every backspace is checked — the next request's input is not touched (Claude ${version})`, async () => {
    const s = setup();
    s.show(name, 'typed12');
    await s.watcher.sweep();
    const posted = s.e.pendingQuestion!;
    assert.equal(posted.questions[0].toolUseId, 'toolu_main0');
    // The request asked next, as its screen and transcript have it: another
    // call, another command, `1` typed into its field by someone at the terminal.
    const first = live(`${name}.transcript.jsonl`);
    const next = (text: string) => text.replaceAll('nonexistent', 'other-build');
    assert.notEqual(next(reader('typed')), reader('typed'));
    s.tmux.sendKeys = async (n: string, ...k: string[]) => {
      s.tmux.keys.push(...k);
      if (s.tmux.keys.length > 1) return void s.tmux.panes.set(n, next(reader('cleared'))); // what a second backspace would do to it
      s.transcript(`${first}${callResult('toolu_main0')}\n${next(first).replaceAll('toolu_main0', 'toolu_main1')}`);
      s.tmux.panes.set(n, next(reader('typed')).replace('to cancel: 2\n', 'to cancel: 1\n'));
    };
    const r = (await s.run('answer scout 2')).content;
    assert.match(r, /^Only part of the answer reached .*: sent `BSpace`, then stopped — its screen no longer shows the request the answer was for, so nothing more was sent\./);
    assert.deepEqual(s.tmux.keys, ['BSpace']);
    // The request that is there now is posted with its own input, and is the one to answer.
    assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main1');
    assert.equal(s.e.pendingQuestion?.questions[0].typed, '1');
    assert.match(s.posts.out.at(-1)!, /Its input field holds `1` now; I clear that first\.[\s\S]*other-build/);

    // esc: Escape cancels it whatever is typed.
    const esc = setup();
    esc.show(name, 'typed');
    await esc.watcher.sweep();
    assert.match((await esc.run('answer scout esc')).content, /Dismissal sent/);
    assert.deepEqual(esc.tmux.keys, ['Escape']);
  });
}

test('input layouts not known here, and a prompt not shown from its start, send no keys — with or without a transcript line', async () => {
  for (const pane of [
    fixture('2.1.323', 'ax-clipped'), // heading scrolled off, instruction wrapped
    PERMISSION_PANE.replace(' ❯ 1. Yes', '   1. Yes'),
    PERMISSION_PANE.replace(' Esc to cancel', ' Press Enter to confirm\n Esc to cancel'),
    PERMISSION_PANE.replace(' · Tab to amend', ''), // a cursor list without the hint, and no amended row
    fixture('2.1.323', 'ax-open').replace('[1-2]', '[1-9]'), // not the range of the options listed
  ]) {
    const s = setup();
    s.tmux.panes.set(s.e.tmuxSession, pane);
    await s.watcher.sweep();
    assert.match(s.posts.out.at(-1)!, /requires terminal input/);
    assert.doesNotMatch(s.posts.out.at(-1)!, /answer scout/);
    // TASK-BYSTH: what the post offers instead of an answer — reading it again.
    assert.match(s.posts.out.at(-1)!, /`@\*\*CC Spawner\*\* show scout` reads its screen again\.\n/);
    assert.doesNotMatch(s.posts.out.at(-1)!, /press/);
    assert.match((await s.run('rescan')).content, /already posted.*respond in the terminal/);
    for (const answer of ['answer scout 2', 'answer scout esc']) {
      assert.match((await s.run(answer)).content, /requires terminal input.*no keys sent/);
    }
    assert.deepEqual(s.tmux.keys, []);
    assert.equal(s.e.pendingQuestion?.answeredWith, undefined);
  }
});

test('the three-option Create-file post gives no hardcoded approval or denial numbers', async () => {
  const s = setup();
  s.tmux.panes.set(s.e.tmuxSession, fixture('2.1.323', 'untimed-create'));
  await s.watcher.sweep();
  assert.match(s.posts.out[0], /Answer with the displayed option number: `@\*\*CC Spawner\*\* answer scout <number>`/);
  assert.match(s.posts.out[0], /> 2\. \*\*Yes, and switch to accept edits .* for this session/);
  assert.match(s.posts.out[0], /> 3\. \*\*No\*\*/);
  assert.doesNotMatch(s.posts.out[0], /to approve|to deny/);
});

test('the first sweep refreshes a saved legacy permission signature without claiming resolution', async () => {
  const s = setup();
  const q = {
    kind: 'permission' as const, title: 'Bash command', detail: 'rm -rf "$X/build"',
    question: 'Do you want to proceed?', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }],
  };
  const sig = ['permission', q.title, q.detail, q.question, 'Yes', 'No'].join('§');
  s.registry.update(s.e, { pendingQuestion: { sig, postedAt: new Date().toISOString(), questions: [q], messageId: '5' } });
  s.registry.load();
  s.tmux.panes.set(s.e.tmuxSession, PERMISSION_PANE);
  // An answer that comes in before the first sweep: the saved post is not
  // this run's, so it takes none — and what is on screen is posted there and then.
  assert.match((await s.run('answer scout 1')).content, /posted before I was last restarted.*no keys sent\. What its screen shows now is posted in its home topic — answer that post\./);
  assert.deepEqual(s.tmux.keys, []);
  assert.equal(s.posts.out.length, 1);
  assert.match(s.posts.out[0], /^🔐/);
  assert.notEqual(s.registry.findAlive('scout')?.pendingQuestion?.sig, sig);
  await s.watcher.sweep();
  await s.watcher.sweep();
  assert.match((await s.run('rescan')).content, /already posted/);
  assert.equal(s.posts.out.length, 1);
});

test('a changed command in a countdown prompt rejects the stale answer and gets a new post', async () => {
  const s = setup();
  s.transcript(COUNTDOWN_CALLS);
  s.tmux.panes.set(s.e.tmuxSession, countdownPane('tick2'));
  await s.watcher.sweep();
  const sig = s.e.pendingQuestion?.sig;

  // The timer, permission warning, and options are identical; only the command differs.
  s.tmux.panes.set(s.e.tmuxSession, countdownPane('different'));
  assert.match((await s.run('answer scout 1')).content, /moved on to a different question/);
  assert.deepEqual(s.tmux.keys, []);
  await s.watcher.sweep();
  assert.notEqual(s.e.pendingQuestion?.sig, sig);
  assert.equal(s.posts.out.filter((post) => post.startsWith('🔐')).length, 2);
  assert.match(s.posts.out.at(-1)!, /other-build/);
});

test('an unposted replacement cannot take answers and is retried on the next sweep', async () => {
  const s = setup();
  s.transcript(COUNTDOWN_CALLS);
  s.tmux.panes.set(s.e.tmuxSession, countdownPane('tick2'));
  await s.watcher.sweep();
  const old = s.e.pendingQuestion;
  assert.ok(old?.messageId);

  s.tmux.panes.set(s.e.tmuxSession, countdownPane('different'));
  s.posts.fail = true;
  const scan = await s.run('rescan');
  assert.match(scan.content, /could not post in its home topic; will retry/);
  assert.doesNotMatch(scan.content, /posted in its home topic/);
  assert.equal(s.posts.out.length, 1);
  assert.notEqual(s.e.pendingQuestion?.sig, old.sig);
  assert.equal(s.e.pendingQuestion?.messageId, undefined);
  assert.match((await s.run('answer scout 2')).content, /hasn't been posted yet.*no keys sent/);
  assert.deepEqual(s.tmux.keys, []);

  s.posts.fail = false;
  await s.watcher.sweep();
  assert.match(s.posts.out.at(-1)!, /other-build/);
  assert.match((await s.run('rescan')).content, /already posted/);
  assert.equal(s.posts.out.length, 2);
  assert.match((await s.run('answer scout 2')).content, /Answer sent/);
  assert.deepEqual(s.tmux.keys, ['2']);
});

test('consecutive permission prompts report the choice sent, not a confirmed outcome', async () => {
  const s = setup();
  s.transcript(COUNTDOWN_CALLS);
  s.tmux.panes.set(s.e.tmuxSession, countdownPane('tick2'));
  await s.watcher.sweep();
  s.tmux.sendKeys = async (session, ...keys) => {
    s.tmux.keys.push(...keys);
    s.tmux.panes.set(session, countdownPane('different'));
  };
  const r = await s.run('answer scout 2');
  assert.match(r.content, /Answer sent.*\*\*No\*\*\. This confirms the key was sent, not the outcome/);
  assert.doesNotMatch(r.content, /I'll confirm|that part is answered/);
  assert.deepEqual(s.tmux.keys, ['2']);
  await s.watcher.sweep();
  assert.equal(s.posts.out.length, 2);
  assert.match(s.posts.out[1], /^🔐.*\n[\s\S]*other-build/);
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

test('permission answers require creator/owner; shared AskUserQuestion stays collaborative', async () => {
  const s = setup();
  for (const pane of [PERMISSION_PANE, ASK_PANE]) {
    s.tmux.panes.set(s.e.tmuxSession, pane);
    await s.watcher.sweep();
    const result = await s.run('answer scout 1', home, { ...tester, userId: 9 });
    assert.match(result.content, /Answer sent/);
  }
  s.tmux.keys = [];
  s.tmux.panes.set(s.e.tmuxSession, PERMISSION_PANE);
  await s.watcher.sweep();
  // Change creator while retaining a generally allowed invoker.
  s.e.spawnedBy = { userId: 2, username: 'Other' };
  assert.match((await s.run('yes')).content, /Only this hand's creator/);
  assert.deepEqual(s.tmux.keys, []);
  s.tmux.panes.set(s.e.tmuxSession, ASK_PANE);
  await s.watcher.sweep();
  assert.match((await s.run('answer scout 1')).content, /Answer sent/);
  assert.ok(s.tmux.keys.length > 0);
});

// ── TASK-BYSTH: the pane is fitted to the prompt ──

/** A Bash prompt whose command is `lines` lines long, whole on a tall pane. */
const longPane = (lines: number, mark = 'x') => [
  '────────────────────────────────────────────────────────────────────────────────',
  ' Bash command',
  ' Write the list',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  " │ cat <<'END'",
  ...Array.from({ length: lines }, (_, i) => ` │ item ${String(i).padStart(4, '0')} ${mark.repeat(60)}`),
  ' │ END',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  ' Permission rule Bash requires confirmation for this command.',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');
/** The rows quoted in a run of posts, in order. */
const quoted = (posts: string[]) => posts.flatMap((post) => [...post.matchAll(/```\n([\s\S]*?)\n```/g)].flatMap((m) => m[1].split('\n')));

/** That prompt as a full-screen TUI draws it on a pane of `rows` rows: whole
 *  from the top when it fits, else its last rows (the top is off screen). */
const drawnOn = (pane: string, rows: number) => {
  const frame = pane.split('\n');
  return frame.length <= rows ? pane : frame.slice(-rows).join('\n');
};


for (const version of ['2.1.323', '2.1.306']) {
  /** Live captures of one 30-line heredoc prompt under its countdown, at
   *  80x24 (the pane starts inside the command box), 80x48 (its first row is
   *  the title) and 80x60 (rule on screen) — fixtures/dialogs: tall30. */
  const tall = (rows: number) => live(`tall30-${version}.styled-${rows < 48 ? 24 : rows < 60 ? 48 : 60}.txt`);
  const hand = (rows: number, at: (rows: number) => string, fit?: PaneFit) => {
    const tmux = new SizedTmux(rows, at);
    const s = setup(tmux, fit);
    s.transcript(live(`tall30-${version}.transcript.jsonl`));
    return { ...s, tmux };
  };

  test(`a prompt taller than its pane: the pane is made taller, and the prompt is posted whole and answered (Claude ${version})`, async () => {
    // A hand started before this change: 80x24, where an 8-line heredoc under
    // a countdown already lost its title.
    const s = hand(24, tall);
    await s.watcher.sweep();
    assert.deepEqual(s.tmux.resizes, [50]); // to the configured height: enough here
    assert.equal(s.e.paneGrown, true);
    assert.equal(s.posts.out.length, 1); // never posted as "terminal-only" on the way
    const q = s.e.pendingQuestion!.questions[0];
    assert.equal(q.toolUseId, 'toolu_main0');
    assert.equal(q.requiresTerminal, undefined);
    assert.equal(q.title, 'Bash command');
    assert.match(s.posts.out[0], /answer scout <number>/);
    assert.doesNotMatch(s.posts.out[0], /requires terminal input|off the hand's screen/);
    // The whole request, as the terminal shows it: every line of the heredoc.
    for (let i = 0; i < 30; i++) assert.match(s.posts.out[0], new RegExp(`\\n │ scratch line ${i}\\n`));
    assert.match(s.posts.out[0], /\n │ cat <<'END'\n[\s\S]*\n │ END\n │ rm -rf "\$\(printf %s \/tmp\/scratch\/nonexistent\)"\n╌/);
    // No further resize while it waits; the answer is checked on the same screen.
    await s.watcher.sweep();
    assert.match((await s.run('rescan')).content, /already posted/);
    assert.deepEqual(s.tmux.resizes, [50]);
    assert.equal(s.posts.out.length, 1);
    assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
    assert.deepEqual(s.tmux.keys, ['2']);
    s.tmux.panes.set(s.e.tmuxSession, '> working');
    await s.watcher.sweep();
    assert.match(s.posts.out.at(-1)!, /resolved — \*\*No\*\* sent from Zulip/);
    // 50 rows is the configured height: nothing to restore.
    assert.deepEqual(s.tmux.resizes, [50]);
    assert.equal(s.e.paneGrown, undefined);
  });

  test(`a pane grown for a prompt goes back to its configured height once no dialog is open (Claude ${version})`, async () => {
    // A 60-line command (untimed, no transcript): at the configured 50 rows
    // its prompt is still cut, 100 rows show it.
    const pane = longPane(60);
    const tmux = new SizedTmux(50, (rows) => drawnOn(pane, rows));
    const s = { ...setup(tmux), tmux };
    await s.watcher.sweep();
    assert.deepEqual(s.tmux.resizes, [100]);
    assert.equal(s.e.pendingQuestion?.questions[0].requiresTerminal, undefined);
    assert.deepEqual(quoted(s.posts.out), pane.split('\n').slice(2, -6));
    // While the dialog is open the height stays.
    await s.watcher.sweep();
    assert.deepEqual(s.tmux.resizes, [100]);
    // Someone made the pane small again meanwhile: the answer path fits it
    // like the sweep did, and it is the posted request that it then reads.
    s.tmux.rows = 24;
    assert.match((await s.run('answer scout 1')).content, /Answer sent.*\*\*Yes\*\*/);
    assert.deepEqual(s.tmux.resizes, [100, 50, 100]);
    assert.deepEqual(s.tmux.keys, ['1']);
    assert.equal(s.posts.out.length, 1);
    // With no dialog open, it goes back — once.
    assert.equal(s.tmux.panes.get(s.e.tmuxSession), '> working');
    await s.watcher.sweep();
    assert.deepEqual(s.tmux.resizes, [100, 50, 100, 50]);
    assert.equal(s.e.paneGrown, undefined);
    await s.watcher.sweep();
    assert.deepEqual(s.tmux.resizes, [100, 50, 100, 50]);
  });

  test(`a prompt that does not fit the tallest pane either stays what it was: posted once, no key (Claude ${version})`, async () => {
    // The 30-line heredoc under its countdown (tied to its call) on a hand
    // whose pane may be 30 rows at most: grown to that, it still starts inside
    // the command box.
    const frame = captureText(tall(60)).trimEnd();
    const s = hand(24, (rows) => drawnOn(frame, rows), { rows: 26, maxRows: 30 });
    await s.watcher.sweep();
    assert.deepEqual(s.tmux.resizes, [30]);
    const q = s.e.pendingQuestion!.questions[0];
    assert.equal(q.terminalWhy, 'cut');
    assert.equal(q.toolUseId, 'toolu_main0'); // the hint against reposting, as before
    assert.match(s.posts.out[0], /The top of this prompt is off the hand's screen[\s\S]*could not make it tall enough[\s\S]*will not pass on an answer to it[\s\S]*requires terminal input\. `@\*\*CC Spawner\*\* show scout` reads its screen again\./);
    assert.doesNotMatch(s.posts.out[0], /answer scout|press|⏳/);
    await s.watcher.sweep();
    assert.deepEqual(s.tmux.resizes, [30]);
    assert.equal(s.posts.out.length, 1);
    for (const answer of ['answer scout 1', 'answer scout esc']) {
      assert.match((await s.run(answer)).content, /requires terminal input — no keys sent/);
    }
    assert.deepEqual(s.tmux.keys, []);
  });

  test(`a redraw that comes late is waited for; a screen that stays as it was is not grown further (Claude ${version})`, async () => {
    // tmux pads the taller pane with blank rows at once; the TUI draws the
    // prompt anew some 400 ms later.
    const frame = captureText(tall(60)).trimEnd();
    let resizedAt = 0;
    const late = new SizedTmux(24, (rows) => (rows > 24 && Date.now() - resizedAt < 400 ? `${drawnOn(frame, 24)}${'\n'.repeat(rows - 24)}` : drawnOn(frame, rows)));
    const resize = late.resizeWindowRows.bind(late);
    late.resizeWindowRows = async (n: string, rows: number) => {
      resizedAt = Date.now();
      await resize(n, rows);
    };
    const s = setup(late, { rows: 60, maxRows: 1000 });
    s.transcript(live(`tall30-${version}.transcript.jsonl`));
    await s.watcher.sweep();
    assert.deepEqual(late.resizes, [60]); // one resize: the late frame was the one read
    assert.equal(s.e.pendingQuestion?.questions[0].requiresTerminal, undefined);
    assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main0');
    assert.equal(s.posts.out.length, 1);

    // A program that does not redraw at all: one resize, then left as it reads.
    const still = hand(24, () => drawnOn(frame, 24));
    await still.watcher.sweep();
    assert.deepEqual(still.tmux.resizes, [50]);
    assert.equal(still.e.pendingQuestion?.questions[0].terminalWhy, 'cut');
    assert.equal(still.e.paneGrown, true); // and it goes back once the prompt is gone
    still.tmux.panes.set(still.e.tmuxSession, '> working');
    await still.watcher.sweep();
    assert.deepEqual(still.tmux.resizes, [50]);
    assert.equal(still.e.paneGrown, undefined);
  });

  test(`tmux will not resize, or the frame leaves rows free: the pane is left alone (Claude ${version})`, async () => {
    const refused = hand(24, tall);
    refused.tmux.refuse = true;
    await refused.watcher.sweep();
    assert.deepEqual(refused.tmux.resizes, []);
    assert.equal(refused.e.paneGrown, undefined);
    assert.equal(refused.e.pendingQuestion?.questions[0].terminalWhy, 'cut');
    assert.match((await refused.run('answer scout 1')).content, /requires terminal input — no keys sent/);
    // tmux takes the command and keeps the size: not waited for, not retried in a loop.
    const stuck = hand(24, tall);
    stuck.tmux.resizeWindowRows = async (_n: string, rows: number) => void stuck.tmux.resizes.push(rows);
    const began = Date.now();
    await stuck.watcher.sweep();
    assert.deepEqual(stuck.tmux.resizes, [50]);
    assert.ok(Date.now() - began < 2000);
    assert.equal(stuck.e.paneGrown, undefined);
    assert.equal(stuck.e.pendingQuestion?.questions[0].terminalWhy, 'cut');
    // A frame that fits is drawn from the top, with rows to spare under it: a
    // prompt that is not shown from its start THERE would not be on a taller pane.
    const roomy = hand(30, () => `${tall(24)}\n\n\n\n\n\n`);
    await roomy.watcher.sweep();
    assert.deepEqual(roomy.tmux.resizes, []);
    assert.equal(roomy.e.pendingQuestion?.questions[0].terminalWhy, 'cut');
    // Anything but a permission prompt not shown from its title: never resized.
    for (const pane of [ASK_PANE, PERMISSION_PANE, '> working', PERMISSION_PANE.replace(' ❯ 1. Yes', '   1. Yes')]) {
      const s = hand(24, () => pane);
      await s.watcher.sweep();
      assert.deepEqual(s.tmux.resizes, []);
    }
  });

  test(`a subagent's prompt whose title is off screen is answerable once the pane shows it (Claude ${version})`, async () => {
    // fixtures/dialogs: subtall30 — a background subagent's 30-line heredoc, at 80x24 and 80x80.
    const sub = (rows: number) => live(`subtall30-${version}.styled-${rows < 50 ? 24 : 80}.txt`);
    const tmux = new SizedTmux(24, sub);
    const s = setup(tmux);
    s.transcript(live(`subtall30-${version}.transcript.jsonl`));
    await s.watcher.sweep();
    assert.deepEqual(tmux.resizes, [50]);
    const q = s.e.pendingQuestion!.questions[0];
    assert.equal(q.title, 'Bash command · from the general-purpose agent');
    assert.equal(q.toolUseId, undefined); // its call is in the subagent's transcript
    assert.equal(q.requiresTerminal, undefined);
    assert.match(s.posts.out[0], /answer scout <number>[\s\S]*\*\*Bash command · from the general-purpose agent\*\*\n```\n sub heredoc\n/);
    assert.match(s.posts.out[0], /\n │ scratch line 0\n[\s\S]*\n │ scratch line 29\n/);
    assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
    assert.deepEqual(tmux.keys, ['2']);
  });
}

// ── TASK-BYSTH: long requests, and `show` ──

test('a long request is posted whole, over as many posts as it takes; its options come last', async () => {
  const s = setup();
  let id = 100;
  s.posts.postHome = async (_e: unknown, c: string) => {
    s.posts.out.push(c);
    return id++;
  };
  const pane = longPane(150);
  s.tmux.panes.set(s.e.tmuxSession, pane);
  await s.watcher.sweep();
  assert.equal(s.posts.out.length, 2);
  for (const post of s.posts.out) assert.ok(post.length <= 9500, `a post of ${post.length} characters`);
  assert.match(s.posts.out[0], /^🔐 [\s\S]*answer scout <number>[\s\S]*\n\*This request takes 2 messages; its options are at the end of the last one\.\*\n\*\*Bash command\*\*\n```\n Write the list\n/);
  assert.match(s.posts.out[1], /^🔐 \*\*Claude-Code-opus-5-5-scout\*\*'s permission request, continued \(2\/2\):\n```\n/);
  assert.match(s.posts.out[1], /\n```\n\*\*Do you want to proceed\?\*\*\n> 1\. \*\*Yes\*\*\n> 2\. \*\*No\*\*\nAnswer with the displayed option number: [^\n]*$/);
  // Every row above the question, once, in order — nothing cut out of the middle.
  assert.deepEqual(quoted(s.posts.out), pane.split('\n').slice(2, -6));
  assert.equal(s.e.pendingQuestion?.abridged, undefined);
  assert.equal(s.e.pendingQuestion?.messageId, '100');
  assert.equal(s.e.pendingQuestion?.lastMessageId, '101');
  // An answer sent between its two posts was not written looking at all of it.
  const answer = (messageId: number) => s.actions.run({ cmd: parseCommand('answer scout 1'), body: 'answer scout 1', where: home, invoker: tester, messageId });
  assert.match((await answer(100)).content, /sent before .*current request was posted.*no keys sent/);
  assert.deepEqual(s.tmux.keys, []);
  assert.match((await answer(102)).content, /Answer sent.*\*\*Yes\*\*/);
  assert.deepEqual(s.tmux.keys, ['1']);

  // A post that fails part-way: not posted — no answer is taken, and it is retried whole.
  const flaky = setup();
  let fail = 2;
  flaky.posts.postHome = async (_e: unknown, c: string) => (--fail === 0 ? undefined : (flaky.posts.out.push(c), 7));
  flaky.tmux.panes.set(flaky.e.tmuxSession, pane);
  await flaky.watcher.sweep();
  assert.equal(flaky.e.pendingQuestion?.messageId, undefined);
  assert.match((await flaky.run('answer scout 1')).content, /hasn't been posted yet.*no keys sent/);
  await flaky.watcher.sweep();
  assert.equal(flaky.e.pendingQuestion?.messageId, '7');
  assert.deepEqual(quoted(flaky.posts.out.slice(-2)), pane.split('\n').slice(2, -6));
});

test('a very long request is posted as its two ends; it is approved only after `show` posted all of it', async () => {
  const s = setup();
  const pane = longPane(400);
  const rows = pane.split('\n').slice(2, -6);
  s.tmux.panes.set(s.e.tmuxSession, pane);
  await s.watcher.sweep();
  assert.equal(s.posts.out.length, 1);
  assert.equal(s.e.pendingQuestion?.abridged, true);
  const card = s.posts.out[0];
  assert.ok(card.length <= 9500);
  assert.match(card, /This request is too long to post unasked \(406 rows\): below are its first and last rows\. `@\*\*CC Spawner\*\* show scout` posts all of it, in 4 messages, and I pass on an approval only after that\. `@\*\*CC Spawner\*\* answer scout esc` dismisses it as it is\./);
  assert.doesNotMatch(card, /Answer with the displayed option number/);
  const shown = quoted([card]);
  assert.deepEqual(shown.slice(0, 3), rows.slice(0, 3));
  assert.deepEqual(shown.slice(-3), rows.slice(-3));
  assert.match(card, new RegExp(`\\n\\*… ${rows.length - shown.length} rows not shown here — \`@\\*\\*CC Spawner\\*\\* show scout\` posts them …\\*\\n`));
  // No approval — nor any other option — on a request nobody was shown.
  for (const answer of ['answer scout 1', 'answer scout 2', '1', 'yes']) {
    assert.match((await s.run(answer)).content, /too long to post unasked, so only its first and last rows are in the topic — no keys sent\. `show scout` posts all of it/);
  }
  assert.deepEqual(s.tmux.keys, []);
  await s.watcher.sweep();
  assert.equal(s.posts.out.length, 1);

  // show: all of it, in order, then the options and how to answer.
  assert.match((await s.run('show scout')).content, /its permission prompt, as its screen shows it now, is posted in its home topic — answer that post\./);
  assert.equal(s.posts.out.length, 5);
  assert.deepEqual(quoted(s.posts.out.slice(1)), rows);
  for (const post of s.posts.out) assert.ok(post.length <= 9500);
  assert.match(s.posts.out[1], /\*This request takes 4 messages; its options are at the end of the last one\.\*/);
  assert.match(s.posts.out[4], /continued \(4\/4\)[\s\S]*\*\*Do you want to proceed\?\*\*\n> 1\. \*\*Yes\*\*\n> 2\. \*\*No\*\*\nAnswer with the displayed option number/);
  assert.equal(s.e.pendingQuestion?.abridged, undefined);
  // A sweep does not fall back to the two ends.
  await s.watcher.sweep();
  assert.equal(s.posts.out.length, 5);
  assert.equal(s.e.pendingQuestion?.abridged, undefined);
  // What was shown is what is approved: the same rows with one line changed is another request.
  s.tmux.panes.set(s.e.tmuxSession, pane.replace('item 0200 x', 'item 0200 y'));
  assert.match((await s.run('answer scout 1')).content, /moved on to a different question[\s\S]*No keys sent/);
  assert.deepEqual(s.tmux.keys, []);
  assert.equal(s.e.pendingQuestion?.abridged, true); // posted by its two ends again
  s.tmux.panes.set(s.e.tmuxSession, pane);
  await s.run('show scout');
  assert.match((await s.run('answer scout 1')).content, /Answer sent.*\*\*Yes\*\*/);
  assert.deepEqual(s.tmux.keys, ['1']);

  // Dismissing needs no more than the two ends.
  const esc = setup();
  esc.tmux.panes.set(esc.e.tmuxSession, pane);
  await esc.watcher.sweep();
  assert.match((await esc.run('answer scout esc')).content, /Dismissal sent/);
  assert.deepEqual(esc.tmux.keys, ['Escape']);
});

test('show reads the hand\'s screen again and posts what is open, by name or in its topic', async () => {
  const s = setup();
  assert.match((await s.run('show scout')).content, /\*\*Claude-Code-opus-5-5-scout\*\* — no dialog is open on its screen\./);
  assert.match((await s.run('show')).content, /show needs a hand — `show <name>`/);
  assert.match((await s.run('show nobody')).content, /No running hand matches `nobody`/);
  assert.equal(s.posts.out.length, 0);

  // Open, not yet swept: show posts it; it is then the request an answer answers.
  s.show('heredoc6-2.1.323', 'tick0');
  assert.match((await s.run('show scout')).content, /its permission prompt, as its screen shows it now, is posted in its home topic — answer that post\./);
  assert.equal(s.posts.out.length, 1);
  assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main0');
  // Asked again, it posts again — the request as it reads now (a tick later).
  s.tmux.panes.set(s.e.tmuxSession, screen('heredoc6-2.1.323', 'tick1'));
  for (const command of ['show', 'request', 'refresh scout']) await s.run(command);
  assert.equal(s.posts.out.length, 4);
  assert.match(s.posts.out[3], /this request in 1:57/);
  assert.equal(s.e.pendingQuestion?.sig, JSON.parse(JSON.stringify(s.e.pendingQuestion)).sig);
  // In another topic the bare form does not guess.
  assert.match((await s.run('show', { ...home, topic: 'elsewhere' })).content, /show needs a hand/);
  assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);

  // Gone from the screen: closed out, as rescan would.
  s.tmux.panes.set(s.e.tmuxSession, '> working');
  s.show('heredoc6-2.1.323', 'tick0');
  await s.watcher.sweep();
  s.tmux.panes.set(s.e.tmuxSession, '> working');
  assert.match((await s.run('show scout')).content, /no prompt is on its screen any more — it was answered at the terminal or it expired; closed it out\./);
  assert.equal(s.e.pendingQuestion, undefined);

  // A prompt that takes no answer from here is posted with that said.
  const cut = setup();
  cut.show('heredoc400-2.1.323', 'tick0');
  assert.match((await cut.run('show scout')).content, /is posted in its home topic \(it takes no answer from here yet — the post says why\)\./);
  // An unreadable screen changes nothing.
  cut.tmux.capturePane = async () => {
    throw new Error('sudo: a password is required');
  };
  const pending = cut.e.pendingQuestion;
  assert.match((await cut.run('show scout')).content, /could not read its screen \(sudo: a password is required\); nothing was changed\./);
  assert.equal(cut.e.pendingQuestion, pending);
});

// ── TASK-BYSTH: findings of the independent review ──

test('one post takes one answer: a second answer to it is refused, and a prompt still open is posted again', async () => {
  const s = setup();
  s.show('heredoc6-2.1.323', 'tick0');
  await s.watcher.sweep();
  // The key goes out, the prompt stays (it did not take — or the next request reads the same).
  s.tmux.sendKeys = async (_n: string, ...k: string[]) => void s.tmux.keys.push(...k);
  const first = (await s.run('answer scout 1')).content;
  assert.match(first, /Answer sent.*\*\*Yes\*\*[\s\S]*still showing the same question after my keystrokes — it is posted again at the next sweep if it stays open/);
  assert.deepEqual(s.tmux.keys, ['1']);
  // A second answer to that post — by whoever, written looking at it: no key;
  // the prompt that is open is posted as a request of its own.
  let id = 100;
  s.posts.postHome = async (_e: unknown, c: string) => {
    s.posts.out.push(c);
    return id++;
  };
  const cards = () => s.posts.out.filter((post) => post.startsWith('🔐')).length;
  const answer = (text: string, messageId: number) => s.actions.run({ cmd: parseCommand(text), body: text, where: home, invoker: tester, messageId });
  const second = (await answer('answer scout 1', 90)).content;
  assert.match(second, /request already had an answer from Zulip \(\*\*Yes\*\*\) — no keys sent\. What its screen shows now is posted in its home topic — answer that post\.$/);
  assert.equal(cards(), 2);
  assert.equal(s.e.pendingQuestion?.answeredWith, undefined);
  // …and a third, sent before that new post was up, is for the old one as well.
  assert.match((await answer('1', 91)).content, /sent before .*current request was posted.*no keys sent/);
  assert.deepEqual(s.tmux.keys, ['1']);
  await s.watcher.sweep();
  assert.equal(cards(), 2);
  assert.match((await answer('answer scout 2', 101)).content, /Answer sent.*\*\*No\*\*/);
  assert.deepEqual(s.tmux.keys, ['1', '2']);
  // Nobody answers again: the sweep posts what is still open, once.
  await s.watcher.sweep();
  assert.equal(cards(), 3);
  assert.equal(s.e.pendingQuestion?.answeredWith, undefined);
  await s.watcher.sweep();
  assert.equal(cards(), 3);
  // The prompt gone after the answer: a second answer finds nothing to post.
  const gone = setup();
  gone.show('heredoc6-2.1.323', 'tick0');
  await gone.watcher.sweep();
  assert.match((await gone.run('answer scout 1')).content, /Answer sent/);
  assert.match((await gone.run('answer scout 1')).content, /already had an answer from Zulip \(\*\*Yes\*\*\) — no keys sent\. No prompt is on its screen now\.$/);
  assert.deepEqual(gone.tmux.keys, ['1']);
  // Raw keys are not an answer: `press` leaves the post as it is (as before).
  const raw = setup();
  raw.show('heredoc6-2.1.323', 'tick0');
  await raw.watcher.sweep();
  raw.tmux.sendKeys = async (_n: string, ...k: string[]) => void raw.tmux.keys.push(...k);
  await raw.run('press scout tab');
  await raw.watcher.sweep();
  assert.equal(raw.posts.out.length, 1);
  assert.match((await raw.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
});

test('twins with no place in the queue (bypass mode) take no key until one call is left', async () => {
  // Two identical calls of one turn are asked one after the other, each under
  // "Bash command" and its own countdown, the first still pending while the
  // second asks (measured on 2.1.306 / 2.1.323). Nothing on screen says which
  // of them is asking. TASK-BYSTH round 1 answered the one on screen, held to
  // its countdown — and an answer to the first reached the second, asked
  // 130 ms after the first was approved at the terminal (review: clock-*).
  const s = setup();
  s.transcript(`${countdownCall('toolu_a')}\n${countdownCall('toolu_b')}\n`);
  s.tmux.panes.set(s.e.tmuxSession, countdownPane('tick0'));
  await s.watcher.sweep();
  const posted = s.e.pendingQuestion!;
  assert.deepEqual(posted.questions[0].lookalikes, ['toolu_a', 'toolu_b']);
  assert.equal(posted.questions[0].terminalWhy, 'lookalike');
  assert.match(s.posts.out[0], /2 pending requests of this hand read exactly like this one, and nothing on its screen says which of them is asking\. An answer could reach another of them than the one you see, so I will not pass one on\. This permission prompt requires terminal input\. Once only one of them is left pending I can tell it, and post it to be answered\. `@\*\*CC Spawner\*\* show scout` reads its screen again\./);
  assert.doesNotMatch(s.posts.out[0], /answer scout|toolu_|\bpress\b/);
  // Through the ticks — its own or its twin's — it is that one post, and no
  // answer is passed on: not at once, not a tick later, not `esc`.
  for (const tick of ['tick0', 'tick1', 'tick2']) {
    s.tmux.panes.set(s.e.tmuxSession, countdownPane(tick));
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, 1);
    for (const answer of ['answer scout 1', 'answer scout esc']) assert.match((await s.run(answer)).content, /requires terminal input — no keys sent/);
  }
  assert.deepEqual(s.tmux.keys, []);
  // The first has its result: one call fits what is on screen. That request
  // gets its own post, and takes an answer.
  s.transcript(`${countdownCall('toolu_a')}\n${countdownCall('toolu_b')}\n${callResult('toolu_a')}\n`);
  s.tmux.panes.set(s.e.tmuxSession, countdownPane('tick0'));
  await s.watcher.sweep();
  assert.equal(s.posts.out.length, 2);
  assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_b');
  assert.match(s.posts.out[1], /answer scout <number>/);
  assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
  assert.deepEqual(s.tmux.keys, ['2']);
});

test('the screen is the last thing read before a key: a request that took the posted one\'s place during the transcript read gets none', async () => {
  // Review control "reread". Two `sleep 3` calls of one turn, "1 of 2" then
  // "2 of 2". Card 1 is posted. While the answer's transcript read is under
  // way the first is approved at the terminal and runs: both calls are pending
  // still, and the screen says "2 of 2". Round 1 read the pending calls once
  // more AFTER its look at the screen and, finding them unchanged, sent the key
  // on the look from before. Everything read for an answer is recorded here —
  // transcript size, transcript bytes, screen — and the screen must come last.
  const traced = (s: ReturnType<typeof setup>, onRead?: () => void) => {
    const ops: string[] = [];
    const [size, readFrom, capture, send] = [s.host.size.bind(s.host), s.host.readFrom.bind(s.host), s.tmux.capturePane.bind(s.tmux), s.tmux.sendKeys.bind(s.tmux)];
    s.host.size = async (path) => {
      ops.push('size');
      return size(path);
    };
    s.host.readFrom = async (path, from) => {
      ops.push('read');
      const bytes = await readFrom(path, from);
      onRead?.();
      return bytes;
    };
    s.tmux.capturePane = async (n: string) => {
      ops.push('screen');
      return capture(n);
    };
    s.tmux.sendKeys = async (n: string, ...k: string[]) => {
      ops.push('key');
      return send(n, ...k);
    };
    return ops;
  };
  for (const version of ['2.1.323', '2.1.306']) {
    // Two calls that differ in their description: each prompt is tied to its own.
    const s = setup();
    s.show(`pair-${version}`, 'first', 'first');
    await s.watcher.sweep();
    assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main0');
    let ops = traced(s, () => s.show(`pair-${version}`, 'overlap', 'overlap')); // approved at the terminal meanwhile
    const r = (await s.run('answer scout 2')).content;
    assert.match(r, /moved on to a different question[\s\S]*No keys sent\. What its screen shows now is posted in its home topic — answer that post\.$/, version);
    assert.deepEqual(s.tmux.keys, [], version);
    // One read of the transcript, and after it nothing but the screen.
    assert.deepEqual(ops, ['screen', 'size', 'read', 'screen'], version);
    assert.equal(s.posts.out.length, 2);
    assert.match(s.posts.out[1], /\*\*Bash command 2 of 2\*\*/);
    assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main1');
    // …and that card takes the answer: again the screen is read last, then the key.
    ops.length = 0;
    assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/, version);
    assert.deepEqual(ops.slice(0, 5), ['screen', 'size', 'read', 'screen', 'key'], version);
    assert.deepEqual(s.tmux.keys, ['2'], version);

    // Twins (the control itself): no key at any point, whatever the screen does meanwhile.
    const t = setup();
    t.show(`twin-${version}`, 'first', 'first');
    await t.watcher.sweep();
    ops = traced(t, () => t.tmux.panes.set(t.e.tmuxSession, screen(`twin-${version}`, 'overlap')));
    assert.match((await t.run('answer scout 2')).content, /No keys sent\. What its screen shows now is posted in its home topic \(it takes no answer from here — the post says why\)\.$/, version);
    assert.deepEqual(ops, ['screen', 'size', 'read', 'screen'], version);
    assert.match(t.posts.out[1], /\*\*Bash command 2 of 2\*\*/);
    assert.match((await t.run('answer scout 2')).content, /requires terminal input — no keys sent/, version);
    assert.deepEqual(t.tmux.keys, [], version);
  }
});

test('a refused answer says what the new post is: one to answer, one that takes none, or the two ends of a long one', async () => {
  // …a prompt not shown from its start (the pane cannot be resized here).
  const cut = setup();
  cut.show('heredoc6-2.1.323', 'tick0');
  await cut.watcher.sweep();
  cut.show('heredoc400-2.1.323', 'tick0');
  assert.match((await cut.run('answer scout 1')).content, /No keys sent\. What its screen shows now is posted in its home topic \(it takes no answer from here — the post says why\)\.$/);
  // …a very long one.
  const long = setup();
  long.show('heredoc6-2.1.323', 'tick0');
  await long.watcher.sweep();
  long.tmux.panes.set(long.e.tmuxSession, longPane(400));
  assert.match((await long.run('answer scout 1')).content, /No keys sent\. What its screen shows now is posted in its home topic \(its first and last rows; `show scout` posts all of it\)\.$/);
  assert.deepEqual([...cut.tmux.keys, ...long.tmux.keys], []);
});

// ── TASK-BYSTH round 2: the review's controls, as regressions ──

for (const version of ['2.1.323', '2.1.306']) {
  test(`screen-reader layout with no call to tie it to takes no key: the next request reads the same for minutes (Claude ${version})`, async () => {
    // Review control "ax-coarse": twins under bypass, no transcript. Both read
    // "about 2 minutes"; the first was dealt with at the terminal 8 s after its
    // post, and the answer to that post typed its digit and Enter into the
    // second. A clock in minutes says nothing; untied, this layout takes none.
    const s = setup();
    s.tmux.panes.set(s.e.tmuxSession, live(`reader-${version}.pane-open.txt`));
    await s.watcher.sweep();
    const q = s.e.pendingQuestion!.questions[0];
    assert.deepEqual([q.entry, q.toolUseId, q.terminalWhy, q.expiry?.clock, q.expiry?.at], ['reader', undefined, 'unbound', 'about 2 minutes', undefined]);
    assert.match(s.posts.out[0], /No pending call of the hand identifies this request [^\n]*, and it is under Claude Code's countdown[\s\S]*so I will not pass on an answer\. This permission prompt requires terminal input\./);
    assert.doesNotMatch(s.posts.out[0], /answer scout|\bpress\b/);
    // 8 s later the screen reads the same — its own, or the next request's.
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, 1);
    for (const answer of ['answer scout 2', 'answer scout 1', 'answer scout esc']) {
      assert.match((await s.run(answer)).content, /Could not deliver the answer.*requires terminal input — no keys sent/);
    }
    assert.deepEqual(s.tmux.keys, []);
    // One request through its minutes: one post.
    s.tmux.panes.set(s.e.tmuxSession, live(`reader-${version}.pane-open.txt`).replace('about 2 minutes', 'about 1 minute'));
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, 1);
    // A clock that reads MORE than the post's did is a request asked again: a
    // post of its own (and still no key).
    const late = setup();
    late.tmux.panes.set(late.e.tmuxSession, live(`reader-${version}.pane-open.txt`).replace('about 2 minutes', 'about 1 minute'));
    await late.watcher.sweep();
    late.tmux.panes.set(late.e.tmuxSession, live(`reader-${version}.pane-open.txt`));
    await late.watcher.sweep();
    assert.equal(late.posts.out.length, 2);
    assert.match((await late.run('answer scout 2')).content, /requires terminal input — no keys sent/);
    assert.deepEqual([...s.tmux.keys, ...late.tmux.keys], []);
  });

  test(`after Tab a request that reads the same under a notice of its own gets no digit, and is posted (Claude ${version})`, async () => {
    // Review control "between". The prompt was switched to its text field at
    // the terminal (no countdown: a key drops it). The answer sends Tab; before
    // its look at the screen the request is dealt with at the terminal and the
    // next one — the same rows — is asked, under a fresh countdown. Round 1
    // compared the rows without the notice and sent the digit.
    const amended = live(`amend-heredoc6-${version}.pane-yes.txt`);
    const next = screen(`heredoc6-${version}`, 'tick0'); // the same rows on the option list, its countdown running
    // With the hand's transcript still naming the one call (it lags, or the
    // next call is its twin): the notice that is there anew stops the answer.
    const s = setup();
    s.tmux.panes.set(s.e.tmuxSession, amended);
    s.transcript(live(`amend-heredoc6-${version}.transcript.jsonl`));
    await s.watcher.sweep();
    const q = s.e.pendingQuestion!.questions[0];
    assert.deepEqual([q.entry, q.toolUseId, q.expiry, q.requiresTerminal], ['amend', 'toolu_main0', undefined, undefined]);
    s.tmux.sendKeys = async (n: string, ...k: string[]) => {
      s.tmux.keys.push(...k);
      if (k[0] === 'Tab') s.tmux.panes.set(n, next);
    };
    const r = (await s.run('answer scout 2')).content;
    assert.match(r, /^Only part of the answer reached .*: sent `Tab`, then stopped — its screen no longer shows the request the answer was for, so nothing more was sent\. The dialog may be half-answered\. What its screen shows now is posted in its home topic — answer that post\.$/);
    assert.deepEqual(s.tmux.keys, ['Tab']); // never the digit
    assert.equal(s.posts.out.length, 2);
    assert.match(s.posts.out[1], /answer scout <number>[\s\S]*automatically (block|deny) this request in 1:5\d/);
    assert.equal(s.e.pendingQuestion?.questions[0].entry, 'list');
    assert.equal(s.e.pendingQuestion?.answered, undefined); // the new post is unanswered; the old one is gone
    // With no transcript (as in the control) the text field takes no key at all.
    const blind = setup();
    blind.tmux.panes.set(blind.e.tmuxSession, amended);
    await blind.watcher.sweep();
    assert.equal(blind.e.pendingQuestion?.questions[0].terminalWhy, 'unbound');
    assert.match(blind.posts.out[0], /No pending call of the hand identifies this request [^\n]*, and someone at its terminal switched it to its text field \(Tab\), which takes an answer in two keys/);
    assert.match((await blind.run('answer scout 2')).content, /requires terminal input — no keys sent/);
    assert.deepEqual(blind.tmux.keys, []);
  });
}

test('a pane in a window someone split is made taller by its window\'s height alone: no width is ever set', async () => {
  // Review control "split": the pane's width was given to resize-window, which
  // sizes the WINDOW — a pane beside another shrank to 39, then 18 columns, and
  // the prompt became unreadable. Only rows are asked for now, of the window,
  // by as many as the pane is to gain.
  const version = '2.1.323';
  const tall = (rows: number) => live(`tall30-${version}.styled-${rows < 48 ? 24 : rows < 60 ? 48 : 60}.txt`);
  const calls: unknown[][] = [];
  const split = (below: number, windowPanes: number) => {
    const tmux = new SizedTmux(24, tall);
    tmux.below = below;
    tmux.windowPanes = windowPanes;
    const resize = tmux.resizeWindowRows.bind(tmux);
    tmux.resizeWindowRows = async (...args: [string, number]) => {
      calls.push(args);
      return resize(...args);
    };
    const s = setup(tmux);
    s.transcript(live(`tall30-${version}.transcript.jsonl`));
    return { ...s, tmux };
  };
  // Side by side: the window is as tall as the pane. (No width is ever passed:
  // the call takes none. That real panes keep theirs is the integration test's.)
  const beside = split(0, 2);
  await beside.watcher.sweep();
  assert.deepEqual(calls, [[beside.e.tmuxSession, 50]]);
  assert.equal(beside.e.pendingQuestion?.questions[0].requiresTerminal, undefined);
  assert.deepEqual([beside.e.paneGrown, beside.e.paneWindowRows], [true, 24]);
  // Stacked over a 25-row pane (and its border): the window gains what the pane is to gain.
  calls.length = 0;
  const stacked = split(26, 2);
  await stacked.watcher.sweep();
  assert.deepEqual(calls, [[stacked.e.tmuxSession, 76]]);
  assert.equal(stacked.tmux.rows, 50);
  assert.equal(stacked.e.pendingQuestion?.questions[0].requiresTerminal, undefined);
  assert.deepEqual([stacked.e.paneGrown, stacked.e.paneWindowRows], [true, 50]);
  // …and back: a window that had several panes goes back to the height it
  // had — not to a height worked out from this pane's share of it.
  calls.length = 0;
  stacked.tmux.panes.set(stacked.e.tmuxSession, '> working');
  await stacked.watcher.sweep();
  assert.deepEqual(calls, [[stacked.e.tmuxSession, 50]]);
  assert.deepEqual([stacked.e.paneGrown, stacked.e.paneWindowRows], [undefined, undefined]);
  calls.length = 0;
  beside.tmux.panes.set(beside.e.tmuxSession, '> working');
  await beside.watcher.sweep();
  assert.deepEqual(calls, [[beside.e.tmuxSession, 24]]);
  // Split only after it was grown (no height on record): the rows the pane has too many come off.
  const later = split(26, 2);
  later.tmux.rows = 200;
  later.registry.update(later.e, { paneGrown: true });
  later.tmux.panes.set(later.e.tmuxSession, '> working');
  await later.watcher.sweep();
  assert.deepEqual(calls.at(-1), [later.e.tmuxSession, 76]); // 226 − (200 − 50)
  assert.equal(later.e.paneGrown, undefined);
});

test('raw keys after an answer do not make its post take another answer', async () => {
  // Review edge: answer → `press up` → answer on one post sent `1, Up, 2`. What
  // was sent last is only a label; that the post had its answer is its own fact.
  const s = setup();
  s.show('heredoc6-2.1.323', 'tick0');
  await s.watcher.sweep();
  s.tmux.sendKeys = async (_n: string, ...k: string[]) => void s.tmux.keys.push(...k); // the key does not take
  assert.match((await s.run('answer scout 1')).content, /Answer sent/);
  assert.deepEqual([s.e.pendingQuestion?.answered, s.e.pendingQuestion?.answeredWith], [true, 'Yes']);
  assert.match((await s.run('press scout up')).content, /Sent `Up`/);
  assert.deepEqual([s.e.pendingQuestion?.answered, s.e.pendingQuestion?.answeredWith], [true, 'keys Up']);
  const again = (await s.run('answer scout 2')).content;
  assert.match(again, /already had an answer from Zulip — no keys sent\. What its screen shows now is posted in its home topic — answer that post\.$/);
  assert.deepEqual(s.tmux.keys, ['1', 'Up']);
  // The post that refusal made is a new one, and takes one answer.
  assert.equal(s.posts.out.length, 2);
  assert.equal(s.e.pendingQuestion?.answered, undefined);
  assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
  assert.deepEqual(s.tmux.keys, ['1', 'Up', '2']);
  // An answer of which only part went out spends its post as well.
  const part = setup();
  part.show('amend-2.1.323', 'yes');
  await part.watcher.sweep();
  part.tmux.sendKeys = async (_n: string, ...k: string[]) => void part.tmux.keys.push(...k); // Tab does nothing
  assert.match((await part.run('answer scout 2')).content, /^Only part of the answer reached .*sent `Tab`, then stopped — the prompt did not come back as its option list/);
  assert.equal(part.posts.out.length, 2); // posted anew: that is the one to answer
  assert.equal(part.e.pendingQuestion?.answered, undefined);
  // …also when what is on screen then cannot be posted: the old post stays, spent.
  const stuck = setup();
  stuck.show('amend-2.1.323', 'yes');
  await stuck.watcher.sweep();
  stuck.tmux.sendKeys = async (_n: string, ...k: string[]) => {
    stuck.tmux.keys.push(...k);
    stuck.posts.fail = true;
  };
  assert.match((await stuck.run('answer scout 2')).content, /^Only part of the answer reached .*I could not post what its screen shows now/);
  // (The replacement that could not be posted is the pending one: it takes no
  // answer until a sweep has posted it.)
  stuck.posts.fail = false;
  assert.match((await stuck.run('answer scout 2')).content, /hasn't been posted yet.*no keys sent/);
  assert.deepEqual(stuck.tmux.keys, ['Tab']);
});

test('an answer older than the post of the dialog now open is not passed on — whatever kind of dialog took the place of the one it was for', async () => {
  // Review edge: a permission prompt (post 10) gave way to a question. Answer
  // 11 was refused and the question posted (20); answer 12, already on its way,
  // was typed into the question (`1`, Tab). Nobody answering in message 12 had
  // seen post 20.
  const s = setup();
  let seq = 10;
  s.posts.postHome = async (_e: unknown, c: string) => {
    s.posts.out.push(c);
    const id = seq;
    seq += 10;
    return id;
  };
  const answer = (id: number, text = 'answer scout 1') => s.actions.run({ cmd: parseCommand(text), body: text, where: home, invoker: tester, messageId: id }).then((r) => r.content);
  s.tmux.panes.set(s.e.tmuxSession, PERMISSION_PANE);
  await s.watcher.sweep();
  assert.equal(s.e.pendingQuestion?.messageId, '10');
  s.tmux.panes.set(s.e.tmuxSession, ASK_PANE);
  assert.match(await answer(11), /moved on to a different question[\s\S]*No keys sent\. What its screen shows now is posted/);
  assert.equal(s.e.pendingQuestion?.messageId, '20');
  assert.match(await answer(12), /That answer was sent before \*\*.*\*\*'s current question was posted, so it was for an earlier one — no keys sent\. The question to answer is the last one posted in its home topic\.$/);
  assert.deepEqual(s.tmux.keys, []);
  // One written after the post is an answer to it.
  assert.match(await answer(21), /Answer sent/);
  assert.deepEqual(s.tmux.keys, ['1', 'Tab']);
  // The other way round, and question to question: the same.
  for (const [first, then] of [[ASK_PANE, PERMISSION_PANE], [ASK_PANE, ASK_PANE.replace('How wide?', 'How deep?')]]) {
    const t = setup();
    let n = 10;
    t.posts.postHome = async (_e: unknown, c: string) => {
      t.posts.out.push(c);
      return (n += 10) - 10;
    };
    const send = (id: number) => t.actions.run({ cmd: parseCommand('answer scout 1'), body: 'answer scout 1', where: home, invoker: tester, messageId: id }).then((r) => r.content);
    t.tmux.panes.set(t.e.tmuxSession, first);
    await t.watcher.sweep();
    t.tmux.panes.set(t.e.tmuxSession, then);
    await t.watcher.sweep(); // the replacement is posted (20) while answer 15 waits
    assert.equal(t.e.pendingQuestion?.messageId, '20');
    assert.match(await send(15), /was sent before .* was posted, so it was for an earlier one — no keys sent/);
    assert.deepEqual(t.tmux.keys, []);
  }
});

test('a request is posted to the letter: no row is changed to fit a code block, and no post of a whole request is cut to fit a message', async () => {
  // Review control "markdown": a 400-line Write whose row 200 is "```text" was
  // posted "in full" with three apostrophes there. The block is fenced with
  // more backticks than any run in the rows instead.
  const fenceOf = (post: string) => post.match(/^(`{3,})$/m)?.[1];
  const blocks = (posts: string[]) => posts.flatMap((post) => {
    const f = fenceOf(post);
    return f ? [...post.matchAll(new RegExp(`^${f}\\n([\\s\\S]*?)\\n${f}$`, 'gm'))].flatMap((m) => m[1].split('\n')) : [];
  });
  const marked = (lines: number) => longPane(lines).replace(' │ item 0003 ', ' │ ```text ').replace(' │ item 0005 ', ' │ ````` and ``` ').replace(' │ item 0007 ', " │ ''' ~~~ ");
  // A short one: one post.
  const short = setup();
  short.tmux.panes.set(short.e.tmuxSession, marked(10));
  await short.watcher.sweep();
  const rows = marked(10).split('\n').slice(2, -6);
  assert.equal(short.posts.out.length, 1);
  assert.equal(fenceOf(short.posts.out[0]), '``````'); // one more than the longest run
  assert.deepEqual(blocks(short.posts.out), rows);
  assert.ok(rows.some((row) => row.includes('```text')) && rows.some((row) => row.includes("'''")));
  assert.equal(short.e.pendingQuestion?.abridged, undefined);
  assert.match((await short.run('answer scout 2')).content, /Answer sent/);
  // A very long one: its two ends, then `show` — every row, in order, as on screen.
  const long = setup();
  long.tmux.panes.set(long.e.tmuxSession, marked(400));
  await long.watcher.sweep();
  assert.equal(long.e.pendingQuestion?.abridged, true);
  await long.run('show scout');
  assert.equal(long.e.pendingQuestion?.abridged, undefined);
  const whole = long.posts.out.slice(1);
  assert.deepEqual(blocks(whole), marked(400).split('\n').slice(2, -6));
  for (const post of whole) {
    assert.ok(post.length <= 9000, `a post of ${post.length} characters`);
    assert.doesNotMatch(post, /…$/); // none was cut
  }
  // Wrappers and options count toward a post's size: forty long option labels
  // cannot be had, but a long persona name and target can — every post still fits.
  const wide = setup();
  wide.registry.update(wide.e, { personaName: 'Claude-Code-opus-5-5-' + 'n'.repeat(700) });
  wide.tmux.panes.set(wide.e.tmuxSession, longPane(150));
  await wide.watcher.sweep();
  assert.equal(wide.e.pendingQuestion?.abridged, undefined);
  assert.deepEqual(quoted(wide.posts.out), longPane(150).split('\n').slice(2, -6));
  for (const post of wide.posts.out) assert.ok(post.length <= 9000 && !post.endsWith('…'), `a post of ${post.length} characters`);
  // A row no post has room for: the request cannot be shown whole, so it is
  // never marked as shown whole — `show` or not — and takes no approval.
  const huge = setup();
  huge.tmux.panes.set(huge.e.tmuxSession, longPane(3).replace('item 0001 ', `item 0001 ${'y'.repeat(9500)} `));
  await huge.watcher.sweep();
  assert.equal(huge.e.pendingQuestion?.abridged, true);
  assert.match(huge.posts.out[0], /This request cannot be posted whole \(it has a row too long for a message\)/);
  await huge.run('show scout');
  assert.equal(huge.e.pendingQuestion?.abridged, true);
  assert.match((await huge.run('answer scout 1')).content, /no keys sent/);
  assert.deepEqual(huge.tmux.keys, []);
});

test('a tied prompt posted with no countdown, then on screen under one: asked again — no key, posted anew', async () => {
  // The call id vouches for a request only as far as the transcript is up to
  // date. A notice that is there and was not when the post was made cannot be
  // that prompt's: a key drops the notice for good, and a prompt read without
  // one does not grow one. (Round-2 review: this held after our own Tab only.)
  const s = setup();
  const ticking = screen('heredoc6-2.1.323', 'tick0');
  // …the same screen without the two rows of its notice.
  const bare = ticking.split('\n').filter((row) => !/will automatically|^ up an unattended session$/.test(captureText(row))).join('\n');
  assert.doesNotMatch(captureText(bare), /automatically|unattended session/);
  s.tmux.panes.set(s.e.tmuxSession, bare);
  s.transcript(live('heredoc6-2.1.323.transcript.jsonl'));
  await s.watcher.sweep();
  const q = s.e.pendingQuestion!.questions[0];
  assert.deepEqual([q.toolUseId, q.expiry, q.requiresTerminal], ['toolu_main0', undefined, undefined]);
  // The same call is still the only pending one the watcher can read; the screen has a countdown.
  s.tmux.panes.set(s.e.tmuxSession, ticking);
  assert.match((await s.run('answer scout 1')).content, /moved on to a different question[\s\S]*No keys sent\. What its screen shows now is posted in its home topic — answer that post\.$/);
  assert.deepEqual(s.tmux.keys, []);
  assert.equal(s.posts.out.length, 2);
  assert.ok(s.e.pendingQuestion?.questions[0].expiry?.at);
  // The other way round — the notice gone, as after a key at the terminal — the post stands.
  s.tmux.panes.set(s.e.tmuxSession, bare);
  await s.watcher.sweep();
  assert.equal(s.posts.out.length, 2);
  assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
  assert.deepEqual(s.tmux.keys, ['2']);
});

// ── Review of e90e6be ──
// 1. The hand's own pane. Everything went to "the session", which is the pane
//    someone selected last: with a second Claude Code session in a split of
//    the hand's window, a card read off the hand's transcript was answered
//    into the other session (panes-bypass). The hand's pane is now told from
//    tmux's record of what each pane was started with, and read and keyed by
//    its id.
// 2. Posts from before a restart. A card posted by PR #17 — which cut the
//    middle out of a long request, and changed its backticks — authorized the
//    request after an upgrade (probes2/legacy, probes3/short); a card whose
//    key went out just before the process died took a second answer from the
//    next one (crash.mts). A permission card takes an answer only in the run
//    of the spawner that posted it.

/** A tmux session of several panes: screens, captures and keys by pane id.
 *  `selected` is what "the session" resolves to. */
class PanesTmux extends ScriptedTmux {
  captured: string[] = [];
  sentTo: string[] = [];
  selected = '%1';
  constructor(started: Record<string, string>) {
    super();
    this.started = started;
  }
  private at(target: string) {
    return target.startsWith('%') ? target : this.selected;
  }
  async sessionUptime() {
    return 60;
  }
  async capturePane(n: string) {
    this.captured.push(this.at(n));
    return this.panes.get(this.at(n)) ?? '';
  }
  async sendKeys(n: string, ...k: string[]) {
    this.keys.push(...k);
    for (const _ of k) this.sentTo.push(this.at(n));
    this.panes.set(this.at(n), '> working');
  }
  async sendText(n: string, t: string) {
    this.text.push(t);
    this.sentTo.push(this.at(n));
  }
}
const HAND = "exec env MCPL_BRIDGE_CONFIG='/x/bridge.json' '/usr/bin/claude' --dangerously-skip-permissions --session-id 's' --model 'claude-opus-5-5'";
const SIBLING = HAND.replace("--session-id 's'", "--session-id 'someone-elses'");

test("a prompt is read from the hand's own pane and answered into it, whichever pane of its session is selected", async () => {
  // Two sessions in one window, both showing a prompt that reads the same;
  // the other one's pane is selected, before the card and ever after.
  const tmux = new PanesTmux({ '%0': HAND, '%1': SIBLING });
  const s = setup(tmux);
  tmux.panes.set('%0', PERMISSION_PANE);
  tmux.panes.set('%1', PERMISSION_PANE);
  await s.watcher.sweep();
  assert.equal(s.posts.out.length, 1);
  assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
  assert.deepEqual(tmux.keys, ['2']);
  assert.deepEqual(tmux.sentTo, ['%0']);
  assert.deepEqual([...new Set(tmux.captured)], ['%0']); // the selected pane was never so much as read
  assert.equal(tmux.panes.get('%1'), PERMISSION_PANE); // the other session still has its prompt
  await s.watcher.sweep();
  assert.match(s.posts.out.at(-1)!, /resolved — \*\*No\*\* sent from Zulip/);

  // The other session's prompt alone is nobody's here: no card, no key.
  const other = new PanesTmux({ '%0': HAND, '%1': SIBLING });
  const o = setup(other);
  other.panes.set('%0', '> working');
  other.panes.set('%1', PERMISSION_PANE);
  await o.watcher.sweep();
  assert.deepEqual(o.posts.out, []);
  assert.match((await o.run('answer scout 1')).content, /no pending question/);
  assert.deepEqual(other.sentTo, []);

  // Raw keys and peek are the hand's, too.
  const raw = new PanesTmux({ '%0': HAND, '%1': SIBLING });
  const r = setup(raw);
  raw.panes.set('%0', 'the hand');
  raw.panes.set('%1', 'the other session');
  assert.match((await r.run('peek scout')).content, /the hand/);
  assert.doesNotMatch((await r.run('peek scout')).content, /the other session/);
  assert.match((await r.run('press scout down enter')).content, /^Sent `Down` `Enter`/);
  assert.deepEqual(raw.sentTo, ['%0', '%0']);
  assert.equal(raw.panes.get('%1'), 'the other session');

  // A multi-question dialog: its keys, the text and the review screen's `1`.
  const ask = new PanesTmux({ '%0': HAND, '%1': SIBLING });
  const a = setup(ask);
  ask.panes.set('%0', ASK_PANE);
  ask.panes.set('%1', ASK_PANE);
  await a.watcher.sweep();
  ask.sendKeys = async (n: string, ...k: string[]) => {
    ask.keys.push(...k);
    for (const _ of k) ask.sentTo.push(n);
    if (k[0] === 'Enter') ask.panes.set(n, 'Review your answers\n Ready to submit your answers?\n ❯ 1. Submit answers\n   2. Cancel');
  };
  assert.match((await a.run('answer scout text: both of them')).content, /Answer sent/);
  assert.deepEqual(ask.keys, ['3', 'Enter', '1']);
  assert.deepEqual([...new Set(ask.sentTo)], ['%0']);
});

test("when the hand's own pane cannot be told, nothing is read and nothing is keyed; its topic is told once", async () => {
  // Its pane is gone and the session lives on in a pane someone opened.
  const tmux = new PanesTmux({ '%0': HAND, '%1': 'bash' });
  const s = setup(tmux);
  tmux.panes.set('%0', PERMISSION_PANE);
  tmux.panes.set('%1', PERMISSION_PANE);
  await s.watcher.sweep();
  assert.equal(s.posts.out.length, 1);
  tmux.started = { '%1': 'bash' };
  await s.watcher.sweep();
  await s.watcher.sweep();
  assert.equal(s.posts.out.length, 2);
  assert.match(s.posts.out[1], /^⚠️ \*\*Claude-Code-opus-5-5-scout\*\*: the one pane of its tmux session `cc-opus-5-5-scout` is running the command this hand was started with — its own pane is gone, or was started by hand\. I read a hand's prompts from its own pane and send keys only there, so until this is put right I relay none of its permission prompts or questions, and pass on no answer to them\.$/);
  // The card is still there; an answer to it goes nowhere, and says why.
  assert.match((await s.run('answer scout 1')).content, /^Could not deliver the answer to .*: the one pane of its tmux session .* its own pane is gone, or was started by hand\. No keys sent\.$/);
  assert.match((await s.run('press scout 1')).content, /^No keys sent to .*: the one pane of its tmux session/);
  assert.match((await s.run('peek scout')).content, /^Cannot show .*'s screen: the one pane of its tmux session/);
  assert.match((await s.run('show scout')).content, /could not read its screen \(the one pane of its tmux session/);
  assert.match((await s.run('rescan')).content, /could not read its screen \(the one pane of its tmux session/);
  assert.deepEqual(tmux.sentTo, []);
  assert.deepEqual(tmux.captured.filter((pane) => pane !== '%0'), []);
  assert.equal(s.posts.out.length, 2);

  // Two panes started for this hand: which of them is it?
  tmux.started = { '%1': 'bash', '%2': HAND.replace('--session-id', '--resume'), '%3': HAND };
  tmux.panes.set('%2', PERMISSION_PANE);
  tmux.panes.set('%3', PERMISSION_PANE);
  assert.match((await s.run('answer scout 1')).content, /2 panes of its tmux session `cc-opus-5-5-scout` were started with this hand's conversation id, and I cannot tell which of them is the hand\. No keys sent\./);
  assert.deepEqual(tmux.sentTo, []);

  // One pane started for it again (a revival by hand, `--resume`): it is the
  // hand's — but not the pane the card was read from. Another process is
  // asking there, however alike it reads: the card takes no answer, the
  // prompt is posted anew, and that post is answered into the new pane.
  tmux.started = { '%1': 'bash', '%2': HAND.replace('--session-id', '--resume') };
  const moved = (await s.run('answer scout 1')).content;
  assert.match(moved, /^Could not deliver the answer to .*: the hand is in another terminal pane than the one this request was posted from\.\nNo keys sent\. What its screen shows now is posted in its home topic — answer that post\.$/);
  assert.deepEqual(tmux.sentTo, []);
  assert.equal(s.posts.out.length, 3);
  assert.match(s.posts.out[2], /^🔐 [^\n]*\n♻️ This replaces an earlier post of this request/);
  assert.equal(s.e.pendingQuestion?.pane, '%2');
  await s.watcher.sweep();
  assert.equal(s.posts.out.length, 3); // posted once; no second warning either
  assert.match((await s.run('answer scout 1')).content, /Answer sent.*\*\*Yes\*\*/);
  assert.deepEqual(tmux.sentTo, ['%2']);
  // …and should that go wrong again later, its topic is told again.
  tmux.started = { '%1': 'bash' };
  await s.watcher.sweep();
  assert.equal(s.posts.out.filter((post) => post.startsWith('⚠️')).length, 2);
});

test("the pane a card was read from is gone by the time it is answered: no key goes to another pane's prompt", async () => {
  const tmux = new PanesTmux({ '%0': HAND, '%1': SIBLING });
  const s = setup(tmux);
  tmux.panes.set('%0', PERMISSION_PANE);
  tmux.panes.set('%1', PERMISSION_PANE);
  await s.watcher.sweep();
  // Claude Code in the hand's pane exits; the pane closes. The other one shows its prompt still.
  tmux.started = { '%1': SIBLING };
  tmux.panes.delete('%0');
  assert.match((await s.run('answer scout 1')).content, /Could not deliver the answer.*its own pane is gone, or was started by hand\. No keys sent\./);
  assert.deepEqual(tmux.sentTo, []);
  assert.equal(tmux.panes.get('%1'), PERMISSION_PANE);
  // tmux itself failing is not "no pane": nothing is concluded from it, and nothing sent.
  const busy = new PanesTmux({ '%0': HAND });
  const b = setup(busy);
  busy.panes.set('%0', PERMISSION_PANE);
  await b.watcher.sweep();
  busy.sessionPanes = async () => { throw new Error('sudo: a password is required'); };
  await b.watcher.sweep();
  assert.equal(b.posts.out.length, 1);
  assert.match((await b.run('answer scout 1')).content, /Could not deliver the answer.*a password is required/);
  assert.deepEqual(busy.sentTo, []);
});

test('press: tmux failing to list the panes sends nothing, and keeps what tmux said out of the reply', async () => {
  const s = setup();
  const detail = 'Command failed: sudo -n -H -u private-agent -- tmux -S /private/agents/tmux.sock list-panes -s -t =scout:';
  s.tmux.sessionPanes = async () => { throw Object.assign(new Error(detail), { stderr: 'private stderr' }); };
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  try {
    const r = await s.run('press scout 1 enter');
    assert.match(r.content, /^No keys sent to \*\*Claude-Code-opus-5-5-scout\*\*: tmux did not tell me which pane of its session is the hand's\.$/);
    assert.doesNotMatch(r.content, /Command failed|sudo|private-agent|\/private\/|tmux\.sock|private stderr/);
    assert.deepEqual(s.tmux.keys, []);
    assert.ok(logs.some((line) => line.includes(detail)), 'detailed error stays in internal logs');
  } finally {
    console.log = originalLog;
  }
});

test("the hand's pane is the one tmux started with its conversation id — as a word of its own, and alive", () => {
  const e = { sessionId: '0b0e8a5c-1111-4222-8333-444455556666', tmuxSession: 'cc-x' };
  const pane = (id: string, command: string, dead = false) => ({ id, dead, synchronized: false, command });
  // tmux 3.4 prints the start command in double quotes, its own quotes escaped.
  const launch = `"exec env MCPL_BRIDGE_CONFIG='/x' ANTHROPIC_CUSTOM_HEADERS=\\"\$(printf '%s\\\\n' 'x-origin: cc-spawner')\\" '/usr/bin/claude' --session-id '${e.sessionId}' --model 'm' \\"\$(cat '/x/seed')\\""`;
  assert.equal(ownPane([pane('%3', launch), pane('%4', '""'), pane('%5', 'bash')], e), '%3');
  for (const by of [`--resume ${e.sessionId}`, `--resume=${e.sessionId}`, `--resume  \\"${e.sessionId}\\"`, `--session-id "${e.sessionId}"`]) {
    assert.equal(ownPane([pane('%4', 'bash'), pane('%9', `"claude ${by} --model m"`)], e), '%9', by);
  }
  // A pane that only mentions the id — someone following the transcript — is
  // not the hand: neither a second claimant beside it, nor its stand-in once it is gone.
  const viewer = pane('%7', `"tail -f /home/agents/.claude/projects/-x/${e.sessionId}.jsonl"`);
  assert.equal(ownPane([pane('%3', launch), viewer], e), '%3');
  assert.throws(() => ownPane([viewer, pane('%8', `"echo ${e.sessionId}"`), pane('%6', `"grep -- --resume /x/${e.sessionId}"`)], e), /none of the 3 panes/);
  // synchronize-panes: a key for this pane would reach every pane of its window.
  assert.throws(() => ownPane([{ ...pane('%3', launch), synchronized: true }, pane('%4', 'bash')], e), /synchronize-panes switched on — a key for the hand would go to every pane of that window/);
  assert.throws(() => ownPane([], e), HandPaneError);
  assert.throws(() => ownPane([pane('%4', 'bash')], e), /the one pane of its tmux session `cc-x`/);
  assert.throws(() => ownPane([pane('%4', 'bash'), pane('%5', '')], e), /none of the 2 panes/);
  assert.throws(() => ownPane([pane('%3', launch, true), pane('%4', 'bash')], e), /none of the 2 panes/); // exited, the pane kept
  assert.throws(() => ownPane([pane('%3', launch), pane('%4', launch)], e), /2 panes .* cannot tell which/);
  // Another conversation whose id only contains this one, or the other way round.
  assert.throws(() => ownPane([pane('%3', launch.replace(e.sessionId, `${e.sessionId}-2`))], e), HandPaneError);
  assert.throws(() => ownPane([pane('%3', launch.replace(e.sessionId, `a${e.sessionId}`))], e), HandPaneError);
  assert.throws(() => ownPane([pane('%3', launch)], { ...e, sessionId: e.sessionId.slice(0, 8) }), HandPaneError);
});

test('synchronize-panes on the hand\'s window: no key is sent while a key would reach every pane', async () => {
  const tmux = new PanesTmux({ '%0': HAND, '%1': SIBLING });
  const s = setup(tmux);
  tmux.panes.set('%0', PERMISSION_PANE);
  tmux.panes.set('%1', PERMISSION_PANE);
  await s.watcher.sweep();
  assert.equal(s.posts.out.length, 1);
  tmux.synchronized.add('%0').add('%1');
  const r = (await s.run('answer scout 1')).content;
  assert.match(r, /^Could not deliver the answer to .*: the window of its pane in tmux session `cc-opus-5-5-scout` has synchronize-panes switched on — a key for the hand would go to every pane of that window\. No keys sent\.$/);
  assert.match((await s.run('press scout 1')).content, /^No keys sent to .*synchronize-panes switched on/);
  assert.deepEqual(tmux.sentTo, []);
  await s.watcher.sweep();
  await s.watcher.sweep();
  assert.equal(s.posts.out.length, 2);
  assert.match(s.posts.out[1], /^⚠️ .*synchronize-panes switched on.*until this is put right I relay none of its permission prompts/);
  // Switched off again: the card stands (same run, same pane) and takes its answer.
  tmux.synchronized.clear();
  await s.watcher.sweep();
  assert.equal(s.posts.out.length, 2);
  assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
  assert.deepEqual(tmux.sentTo, ['%0']);
  assert.equal(tmux.panes.get('%1'), PERMISSION_PANE);
});

test('a card is for the pane it was read from: the hand found in another pane gets a new card at the next sweep', async () => {
  const tmux = new PanesTmux({ '%0': HAND });
  const s = setup(tmux);
  tmux.panes.set('%0', PERMISSION_PANE);
  await s.watcher.sweep();
  assert.equal(s.e.pendingQuestion?.pane, '%0');
  // The hand's process is another one now, in another pane, showing a prompt that reads the same.
  tmux.started = { '%4': HAND.replace('--session-id', '--resume') };
  tmux.panes.delete('%0');
  tmux.panes.set('%4', PERMISSION_PANE);
  await s.watcher.sweep();
  await s.watcher.sweep();
  assert.equal(s.posts.out.length, 2);
  assert.match(s.posts.out[1], /^🔐 [^\n]*\n♻️ This replaces an earlier post of this request/);
  assert.equal(s.e.pendingQuestion?.pane, '%4');
  assert.match((await s.run('rescan')).content, /already posted, still waiting/);
  assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
  assert.deepEqual(tmux.sentTo, ['%4']);
});

test('the warning that a hand\'s pane cannot be told is repeated until it has reached its topic', async () => {
  const tmux = new PanesTmux({ '%1': 'bash' });
  const s = setup(tmux);
  s.posts.fail = true;
  await s.watcher.sweep();
  await s.watcher.sweep();
  assert.deepEqual(s.posts.out, []);
  s.posts.fail = false;
  await s.watcher.sweep();
  await s.watcher.sweep();
  assert.equal(s.posts.out.length, 1);
  assert.match(s.posts.out[0], /^⚠️ .*its own pane is gone, or was started by hand/);
});

/** A card as PR #17 (fc224c5) saved it for the prompt on `pane`: the same
 *  signature this build gives an untied prompt, no note of who posted it, and
 *  none of how much of the request its post showed. */
const pr17Card = (pane: string, messageId = '5'): PendingQuestion => {
  const d = parseDialogPane(pane);
  assert.ok(d.kind === 'question');
  const q = d.q;
  return { sig: JSON.stringify(['permission', q.title, q.detail, q.question, q.options.map((o) => o.label), false]), postedAt: new Date().toISOString(), questions: [q], messageId };
};

test('a card posted before a restart authorizes nothing: the prompt is posted anew, and that post is answered', async () => {
  for (const first of ['answer', 'sweep'] as const) {
    for (const by of ['pr17', 'earlier run'] as const) {
      // An earlier run posted the prompt; then the spawner was restarted.
      const old = setup();
      old.tmux.panes.set(old.e.tmuxSession, PERMISSION_PANE);
      if (by === 'pr17') old.registry.update(old.e, { pendingQuestion: pr17Card(PERMISSION_PANE) });
      else await old.watcher.sweep();
      const before = old.posts.out.length;
      const s = setup(old.tmux, undefined, old);
      assert.notEqual(s.watcher.run, old.watcher.run);
      // The old card reads exactly like the screen (PR #17's signature is this build's).
      const loaded = s.e.pendingQuestion!;
      assert.equal(loaded.sig, pr17Card(PERMISSION_PANE).sig);
      if (first === 'answer') {
        // Before the first sweep: no key on the old card; the prompt is posted there and then.
        assert.match((await s.run('answer scout 1')).content, /posted before I was last restarted, and a post from before a restart takes no answer — no keys sent\. What its screen shows now is posted in its home topic — answer that post\./);
        assert.deepEqual(s.tmux.keys, []);
      } else {
        await s.watcher.sweep();
      }
      assert.equal(s.posts.out.length, before + 1, `${first} first, card by ${by}`);
      assert.match(s.posts.out.at(-1)!, /^🔐 [^\n]*\n♻️ This replaces an earlier post of this request, which takes no answer any more: I was restarted since it was made, or the hand has moved to another terminal pane\.\nAnswer with the displayed option number/);
      assert.equal(s.e.pendingQuestion?.run, s.watcher.run);
      assert.equal(s.e.pendingQuestion?.sig, loaded.sig);
      // Posted once: further sweeps and rescans leave it.
      await s.watcher.sweep();
      assert.match((await s.run('rescan')).content, /already posted, still waiting/);
      assert.equal(s.posts.out.length, before + 1);
      assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
      assert.deepEqual(s.tmux.keys, ['2']);
    }
  }
});

test('a card whose key went out just before the spawner died takes no second answer from the next one', async () => {
  // Review control crash.mts: the first key was delivered, the process ended
  // before it could save that; the terminal still showed the prompt (the key
  // did not take). The next process answered the same card again.
  const old = setup();
  old.tmux.panes.set(old.e.tmuxSession, PERMISSION_PANE);
  await old.watcher.sweep();
  const onDisk = readFileSync(join(old.dir, 'r.json'), 'utf8'); // what a process killed at its first key leaves
  old.tmux.sendKeys = async (_n: string, ...k: string[]) => void old.tmux.keys.push(...k); // the key does not take
  assert.match((await old.run('answer scout 1')).content, /Answer sent/);
  assert.equal(old.e.pendingQuestion?.answered, true);
  writeFileSync(join(old.dir, 'r.json'), onDisk);
  for (const first of ['answer', 'sweep'] as const) {
    const s = setup(old.tmux, undefined, old);
    assert.equal(s.e.pendingQuestion?.answered, undefined);
    assert.equal(s.e.pendingQuestion?.messageId, '77');
    const posts = s.posts.out.length;
    if (first === 'sweep') await s.watcher.sweep();
    else assert.match((await s.run('answer scout 2')).content, /posted before I was last restarted.*no keys sent/);
    assert.deepEqual(old.tmux.keys, ['1']); // nothing more on the card of the run that died
    assert.equal(s.posts.out.length, posts + 1); // the prompt, still open, is a new card
    writeFileSync(join(old.dir, 'r.json'), onDisk);
  }
});

test('a PR #17 card that left out the middle of a request, or changed it, does not approve it after an upgrade', async () => {
  // probes2/legacy: PR #17 posted a 400-line request with "[… 26787 characters
  // not shown here …]" and kept no note of that. probes3/short: it posted
  // "```" rows as three apostrophes. Either card reads like the screen.
  for (const pane of [longPane(400), PERMISSION_PANE.replace('rm -rf "$X/build"', 'printf %s "```text"')]) {
    const s = setup();
    let id = 100;
    s.posts.postHome = async (_e: unknown, c: string) => {
      s.posts.out.push(c);
      return id++;
    };
    s.tmux.panes.set(s.e.tmuxSession, pane);
    s.registry.update(s.e, { pendingQuestion: pr17Card(pane, '50') });
    s.registry.load();
    const long = pane.length > 9000;
    const answer = (messageId: number, spec = '1') => s.actions.run({ cmd: parseCommand(`answer scout ${spec}`), body: `answer scout ${spec}`, where: home, invoker: tester, messageId });
    // Sent after the old card, before any sweep of this run.
    assert.match((await answer(60)).content, /posted before I was last restarted.*no keys sent/);
    assert.deepEqual(s.tmux.keys, []);
    const now = s.registry.findAlive('scout')!;
    assert.equal(s.posts.out.length, 1);
    assert.equal(now.pendingQuestion?.abridged, long ? true : undefined);
    assert.match(s.posts.out[0], long ? /^🔐 [^\n]*\n♻️ This replaces an earlier post of this request[^\n]*\nThis request is too long to post unasked/ : /^🔐 [^\n]*\n♻️ This replaces an earlier post of this request[^\n]*\nAnswer with/);
    if (!long) {
      // Posted to the letter this time, and answered on that.
      assert.match(s.posts.out[0], /\n````\n {3}│ printf %s "```text"\n````\n/);
      assert.match((await answer(99)).content, /sent before .*current request was posted.*no keys sent/);
      assert.match((await answer(101)).content, /Answer sent.*\*\*Yes\*\*/);
      assert.deepEqual(s.tmux.keys, ['1']);
      continue;
    }
    // Its two ends only: no approval on that either, until `show` has posted all of it —
    // and then only by an answer sent after the last of those posts.
    assert.match((await answer(101)).content, /too long to post unasked.*no keys sent/);
    assert.match((await s.run('show scout')).content, /is posted in its home topic — answer that post/);
    assert.deepEqual(quoted(s.posts.out.slice(1)), pane.split('\n').slice(2, -6));
    assert.equal(now.pendingQuestion?.messageId, '101');
    assert.equal(now.pendingQuestion?.lastMessageId, '104');
    assert.match((await answer(103)).content, /sent before .*current request was posted.*no keys sent/);
    assert.deepEqual(s.tmux.keys, []);
    assert.match((await answer(105)).content, /Answer sent.*\*\*Yes\*\*/);
    assert.deepEqual(s.tmux.keys, ['1']);
  }
});

test('what a restart leaves alone: a notification that takes no answer anyway, and a multiple-choice question', async () => {
  // A prompt for the terminal keeps its one post across restarts.
  const old = setup();
  const pane = PERMISSION_PANE.replace(' · Tab to amend', ''); // an input layout not known here
  old.tmux.panes.set(old.e.tmuxSession, pane);
  await old.watcher.sweep();
  assert.equal(old.e.pendingQuestion?.questions[0].requiresTerminal, true);
  const s = setup(old.tmux, undefined, old);
  await s.watcher.sweep();
  assert.match((await s.run('rescan')).content, /already posted, still waiting \(respond in the terminal\)/);
  assert.equal(s.posts.out.length, 1);
  assert.deepEqual(s.tmux.keys, []);
  // …and resolves as before when it goes.
  s.tmux.panes.set(s.e.tmuxSession, '> working');
  await s.watcher.sweep();
  assert.match(s.posts.out.at(-1)!, /is no longer on screen/);

  // An AskUserQuestion is the hand's own question, not an approval: answered as before.
  const asked = setup();
  asked.tmux.panes.set(asked.e.tmuxSession, ASK_PANE);
  await asked.watcher.sweep();
  const a = setup(asked.tmux, undefined, asked);
  await a.watcher.sweep();
  assert.equal(a.posts.out.length, 1);
  assert.match((await a.run('answer scout 1')).content, /Answer sent/);
  assert.deepEqual(a.tmux.keys, ['1', 'Tab']);
});

integrationTest('real tmux: with another session\'s like-reading prompt in the selected pane, the answer reaches the hand\'s pane and only that', async () => {
  // The review's control (panes-bypass), with two programs that draw the
  // prompt and record the one key they get in place of two Claude Code
  // sessions: the card is the hand's, the selected pane is the other's.
  const dir = tmp();
  const sock = join(dir, 'tmux.sock');
  const host = new LocalHost();
  const real = new Tmux(host, sock);
  const raw = async (...args: string[]) => (await host.exec('tmux', ['-S', sock, ...args])).stdout.trim();
  const wait = async (ok: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 100 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(await ok());
  };
  writeFileSync(join(dir, 'prompt.txt'), `${PERMISSION_PANE}\n`);
  writeFileSync(join(dir, 'tui.sh'), 'cat "$1"; IFS= read -rsn1 key; printf %s "$key" > "$2"; clear; echo "> working"; exec sleep 600\n');
  const tui = (name: string, conversation: string) => `exec bash '${join(dir, 'tui.sh')}' '${join(dir, 'prompt.txt')}' '${join(dir, name)}' --session-id '${conversation}'`;
  const s = setup(real as unknown as ScriptedTmux);
  s.registry.update(s.e, { sessionId: randomUUID() });
  try {
    await real.newSession(s.e.tmuxSession, dir, tui('hand.key', s.e.sessionId), { cols: 80, rows: 24 });
    const hand = await raw('display-message', '-p', '-t', `=${s.e.tmuxSession}:`, '#{pane_id}');
    const other = await raw('split-window', '-v', '-P', '-F', '#{pane_id}', '-t', `=${s.e.tmuxSession}:`, tui('other.key', randomUUID()));
    assert.equal(await raw('display-message', '-p', '-t', `=${s.e.tmuxSession}:`, '#{pane_id}'), other); // selected, and left so
    await wait(async () => (await real.capturePane(hand)).includes('Tab to amend') && (await real.capturePane(other)).includes('Tab to amend'));
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, 1);
    assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
    await wait(() => existsSync(join(dir, 'hand.key')));
    assert.equal(readFileSync(join(dir, 'hand.key'), 'utf8'), '2');
    assert.equal(existsSync(join(dir, 'other.key')), false);
    assert.match(await real.capturePane(other), /Do you want to proceed\?/); // the other session's request is untouched
    await s.watcher.sweep();
    assert.match(s.posts.out.at(-1)!, /resolved — \*\*No\*\* sent from Zulip/);

    // The hand's pane goes; the session lives on in the other. Its prompt is
    // not the hand's: no card for it, no raw key into it, and the topic is told.
    await raw('kill-pane', '-t', hand);
    await s.watcher.sweep();
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, 3);
    assert.match(s.posts.out[2], /^⚠️ .*the one pane of its tmux session .* its own pane is gone, or was started by hand\./);
    assert.match((await s.run('press scout 1')).content, /^No keys sent to /);
    assert.match((await s.run('answer scout 1')).content, /no pending question/);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(existsSync(join(dir, 'other.key')), false);
  } finally {
    await raw('kill-server').catch(() => undefined);
  }
});
