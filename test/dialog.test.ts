import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

function setup() {
  const dir = tmp();
  const cfg = testConfig(dir, { allowedUsers: [1, 9], creatorOnlyControls: true, ownerUserId: 9 });
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
  const host = new LocalHost();
  const watcher = new TranscriptWatcher(registry, host, tmux as unknown as Tmux, posts, { agentsHome: dir, projectDir: dir }, () => 'CC Spawner');
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
  return { registry, tmux, posts, watcher, run, e, transcript, show, host };
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
    // An answer to the first post, before any sweep: refused, no key.
    assert.match((await s.run('answer scout 1')).content, /moved on to a different question/);
    assert.deepEqual(s.tmux.keys, []);
    // rescan must not call the second request "already posted".
    const scan = (await s.run('rescan')).content;
    assert.match(scan, /open permission prompt found, posted/);
    assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main1');
    assert.equal(s.posts.out.length, 2);
    assert.match(s.posts.out[1], /\*\*Bash command 2 of 2\*\*\n```\n Second sample\n/);
    // The first call finishes; the second prompt is the same request as before.
    s.show(name, 'second', 'second');
    await s.watcher.sweep();
    assert.match((await s.run('rescan')).content, /already posted/);
    assert.equal(s.posts.out.length, 2);
    assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
    assert.deepEqual(s.tmux.keys, ['2']);
  });

  test(`two pending calls the dialog cannot tell apart: one terminal-only post each, no key (Claude ${version})`, async () => {
    const s = setup();
    const name = `twin-${version}`;
    s.show(name, 'first', 'first');
    await s.watcher.sweep();
    assert.match(s.posts.out[0], /Several pending requests of this hand look exactly like this one[\s\S]*will not pass on an answer[\s\S]*requires terminal input/);
    assert.doesNotMatch(s.posts.out[0], /answer scout/);
    assert.match(s.posts.out[0], /\*\*Bash command 1 of 2\*\*/);
    await s.watcher.sweep();
    assert.match((await s.run('rescan')).content, /already posted.*respond in the terminal/);
    assert.equal(s.posts.out.length, 1);
    assert.match((await s.run('answer scout 1')).content, /requires terminal input.*no keys sent/);

    // Answered at the terminal; the twin is asked while the first still runs.
    s.show(name, 'overlap', 'overlap');
    assert.match((await s.run('answer scout 1')).content, /moved on to a different question/);
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, 2);
    assert.match(s.posts.out[1], /Several pending requests[\s\S]*\*\*Bash command 2 of 2\*\*/);
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

  test(`an amended prompt takes no digit: it is reposted for the terminal (Claude ${version})`, async () => {
    const s = setup();
    const name = `amend-${version}`;
    s.show(name, 'open');
    await s.watcher.sweep();
    assert.match(s.posts.out[0], /answer scout <number>/);
    // Someone at the terminal pressed Tab: "1. Yes, and tell Claude what to do next".
    s.show(name, 'yes');
    assert.match((await s.run('answer scout 2')).content, /Could not deliver the answer.*moved on to a different question/);
    assert.deepEqual(s.tmux.keys, []);
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, 2);
    assert.match(s.posts.out[1], /requires terminal input; use the terminal to respond[\s\S]*> 1\. \*\*Yes, and tell Claude what to do next\*\*\n> 2\. \*\*No\*\*$/);
    assert.doesNotMatch(s.posts.out[1], /answer scout/);
    assert.match((await s.run('rescan')).content, /already posted.*respond in the terminal/);
    for (const answer of ['answer scout 2', 'answer scout no', '2']) {
      assert.match((await s.run(answer)).content, /requires terminal input.*no keys sent/);
    }
    assert.deepEqual(s.tmux.keys, []);
    assert.equal(s.e.pendingQuestion?.answeredWith, undefined);
    // Back in the list (Tab again), it is the first post's request again.
    s.show(name, 'open');
    await s.watcher.sweep();
    assert.match((await s.run('answer scout 2')).content, /Answer sent.*\*\*No\*\*/);
    assert.deepEqual(s.tmux.keys, ['2']); // and no Enter
  });
}

test('the answer goes to the request that was posted, or nowhere', async () => {
  // Two calls in one message; the first prompt is posted.
  const s = setup();
  s.show('parallel-2.1.323', 'open', 'open');
  await s.watcher.sweep();
  assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main0');
  assert.match(s.posts.out[0], /scratch\/one/);

  // It was answered in the terminal; the second, same-looking prompt is up.
  // Whether or not the transcript has caught up, the posted answer is refused.
  for (const transcript of ['open', 'after1']) {
    s.show('parallel-2.1.323', 'after1', transcript);
    assert.match((await s.run('answer scout 1')).content, /moved on to a different question/);
    assert.deepEqual(s.tmux.keys, []);
  }
  await s.watcher.sweep();
  assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, 'toolu_main1');
  assert.equal(s.posts.out.length, 2);
  assert.match(s.posts.out[1], /scratch\/two/);
  assert.match((await s.run('answer scout 2')).content, /Answer sent/);
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

  // Never readable, nothing posted yet: the prompt is still bridged, by its rows.
  const blind = setup();
  blind.show('heredoc6-2.1.323', 'tick0');
  blind.host.size = s.host.size = async () => {
    throw new Error('sudo: a password is required');
  };
  await blind.watcher.sweep();
  assert.equal(blind.posts.out.length, 1);
  assert.equal(blind.e.pendingQuestion?.questions[0].toolUseId, undefined);
  assert.match(blind.posts.out[0], /answer scout <number>/);
});

for (const version of ['2.1.306', '2.1.323']) {
  test(`with no transcript a ticking prompt is still posted and never misdelivered (Claude ${version})`, async () => {
    // E.g. the hand's session id moved on. Identity falls back to every row on
    // screen, as before this change: an answer at the posted tick works, a
    // later one is refused with zero keys, and the prompt is reposted — the
    // old behaviour, never a drop and never a key to something else.
    const s = setup();
    s.tmux.panes.set(s.e.tmuxSession, countdownPane('tick0', version));
    await s.watcher.sweep();
    assert.equal(s.e.pendingQuestion?.questions[0].toolUseId, undefined);
    assert.match(s.posts.out[0], /answer scout <number>/);
    assert.match(s.posts.out[0], /nonexistent[\s\S]*Dangerous rm operation[\s\S]*automatically (block|deny) this request in 1:59/);
    s.tmux.panes.set(s.e.tmuxSession, countdownPane('tick1', version));
    assert.match((await s.run('answer scout 1')).content, /moved on to a different question/);
    assert.deepEqual(s.tmux.keys, []);
    await s.watcher.sweep();
    assert.equal(s.posts.out.length, 2);
    assert.match((await s.run('answer scout 1')).content, /Answer sent/);
    assert.deepEqual(s.tmux.keys, ['1']);
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
  assert.match((await s.run('answer scout 2')).content, /^Could not deliver the answer/);
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
  assert.match(r.content, /^Only part of the answer reached .*: sent `1`, then tmux failed\. The dialog may be half-answered — inspect with `peek scout`/);
  assert.doesNotMatch(r.content, /Could not deliver|Answer sent/);
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
  test(`a screen-reader prompt is posted once for the terminal and takes no keys (${name})`, async () => {
    const s = setup();
    s.show(name, 'tick0');
    await s.watcher.sweep();
    assert.match(s.posts.out[0], /requires terminal input/);
    assert.doesNotMatch(s.posts.out[0], /answer scout/);
    assert.match(s.posts.out[0], /about 2 minutes/);
    // Its coarse clock moves on (synthetic edit of the captured notice): still that one post.
    s.tmux.panes.set(s.e.tmuxSession, live(`${name}.pane-tick0.txt`).replace('about 2 minutes', 'about 1 minute'));
    await s.watcher.sweep();
    assert.match((await s.run('rescan')).content, /already posted.*respond in the terminal/);
    assert.equal(s.posts.out.length, 1);
    const r = await s.run('answer scout 2');
    assert.match(r.content, /Could not deliver the answer.*requires terminal input.*no keys sent/);
    assert.deepEqual(s.tmux.keys, []);
    assert.equal(s.e.pendingQuestion?.answeredWith, undefined);
  });
}

test('screen-reader and unverified input layouts send no keys, with or without a transcript line', async () => {
  for (const pane of [
    fixture('2.1.323', 'ax-open'),
    fixture('2.1.323', 'ax-typed'), // a buffered digit awaiting Enter
    fixture('2.1.323', 'ax-clipped'), // heading scrolled off, instruction wrapped
    PERMISSION_PANE.replace(' ❯ 1. Yes', '   1. Yes'),
    PERMISSION_PANE.replace(' Esc to cancel', ' Press Enter to confirm\n Esc to cancel'),
    PERMISSION_PANE.replace('1. Yes', '1. Yes, and tell Claude what to do next').replace(' · Tab to amend', ''), // amending
  ]) {
    const s = setup();
    s.tmux.panes.set(s.e.tmuxSession, pane);
    await s.watcher.sweep();
    assert.match(s.posts.out.at(-1)!, /requires terminal input/);
    assert.doesNotMatch(s.posts.out.at(-1)!, /answer scout/);
    assert.match((await s.run('rescan')).content, /already posted.*respond in the terminal/);
    assert.match((await s.run('answer scout 2')).content, /requires terminal input.*no keys sent/);
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
  assert.match((await s.run('answer scout 1')).content, /moved on to a different question/);
  assert.deepEqual(s.tmux.keys, []);
  await s.watcher.sweep();
  assert.equal(s.posts.out.length, 1);
  assert.match(s.posts.out[0], /^🔐/);
  assert.notEqual(s.registry.findAlive('scout')?.pendingQuestion?.sig, sig);
  await s.watcher.sweep();
  assert.match((await s.run('rescan')).content, /already posted/);
  assert.equal(s.posts.out.length, 1);
});

test('a changed command in a countdown prompt rejects the stale answer and gets a new post', async () => {
  const s = setup();
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
