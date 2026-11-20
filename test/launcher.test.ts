import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { LocalHost } from '../src/host.js';
import { ClaudeLauncher, classifyStartup, keysForYes, yesOption } from '../src/launcher.js';
import { isAbsentError, Tmux } from '../src/tmux.js';
import { HandPaneError, ownPane } from '../src/transcript-watch.js';
import { integrationTest, integrationEnabled, fakeClaude, testConfig, tmp } from './helpers.js';

const dir = tmp();
const cfg = testConfig(dir);
const tmux = new Tmux(new LocalHost(), cfg.tmuxSocket);
after(async () => {
  if (!integrationEnabled) return;
  for (const s of await tmux.listSessions()) await tmux.killSession(s);
});

const seedIn = (d: string) => {
  writeFileSync(join(d, 'seed.md'), 'hello');
  return join(d, 'seed.md');
};

const waitFor = async (path: string) => {
  for (let i = 0; i < 50 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 100));
  return JSON.parse(readFileSync(path, 'utf8')) as { argv: string[]; env: Record<string, string | undefined> };
};

test('startup screens are classified', () => {
  assert.equal(classifyStartup('Loading development channels…'), 'dev-channels');
  assert.equal(classifyStartup('Do you want to use this API key?\n 1. Yes\n 2. No (recommended)'), 'api-key');
  assert.equal(classifyStartup('Bypass Permissions mode\n 2. Yes, I accept'), 'bypass-consent');
  assert.equal(classifyStartup('⏵⏵ bypass permissions on'), 'ready');
  assert.equal(yesOption('   1. No (recommended)\n ❯ 2. Yes'), '2');
});

integrationTest('launch line: env file sourced, headers set, effort env cleared, seed passed verbatim', async () => {
  const seed = join(dir, 'seed.md');
  writeFileSync(seed, `Hi "there" — it's $(touch ${dir}/pwned) and \`backticks\`\n`);
  const launcher = new ClaudeLauncher(cfg, tmux);
  const r = await launcher.launch({
    personaName: 'Claude-Code-opus-5-5-t1',
    model: 'claude-opus-5-5',
    effort: 'high',
    sessionId: 'sess-1',
    resume: false,
    tmuxSession: 'cc-test-1',
    bridgeConfig: join(dir, 'bridge.json'),
    seedFile: seed,
    spawnedBy: "Tess O'Tester",
    streamName: 'cc-hands',
    topic: 't',
  });
  assert.deepEqual(r, {});
  const run = await waitFor(join(dir, 'run-sess-1.json'));
  assert.deepEqual(run.argv.slice(0, 9), [
    '--dangerously-skip-permissions',
    '--dangerously-load-development-channels',
    'plugin:mcpl-bridge@mcpl-bridge-dev',
    '--session-id',
    'sess-1',
    '--model',
    'claude-opus-5-5',
    '--effort',
    'high',
  ]);
  assert.equal(run.argv[9], readFileSync(seed, 'utf8').replace(/\n$/, ''));
  assert.ok(!existsSync(join(dir, 'pwned')), 'seed text must not be executed');
  assert.equal(run.env.ANTHROPIC_API_KEY, 'gate-token-from-env-file');
  assert.equal(run.env.CLAUDE_CODE_EFFORT_LEVEL, undefined, 'effort env var is cleared when --effort is passed');
  assert.equal(run.env.MCPL_BRIDGE_CONFIG, join(dir, 'bridge.json'));
  assert.equal(
    run.env.ANTHROPIC_CUSTOM_HEADERS,
    "x-origin: cc-spawner\nx-channel: Claude-Code-opus-5-5-t1\nx-counterparty: Tess O'Tester",
  );
});

integrationTest('the API-key screen is answered with its Yes option', async () => {
  const d = tmp();
  const c = testConfig(d, { claudeBin: fakeClaude(d, 'api-key') });
  const t = new Tmux(new LocalHost(), c.tmuxSocket);
  try {
    const r = await new ClaudeLauncher(c, t).launch({
      personaName: 'p', model: 'claude-opus-5-5', sessionId: 's2', resume: true, tmuxSession: 'cc-test-2',
      bridgeConfig: join(d, 'b.json'), seedFile: seedIn(d), spawnedBy: 'x', streamName: 's', topic: 't',
    });
    assert.deepEqual(r, {});
    assert.equal(readFileSync(join(d, 'keys'), 'utf8').trim(), 'picked=1');
    const run = await waitFor(join(d, 'run-s2.json'));
    assert.ok(run.argv.includes('--resume'));
    assert.ok(!run.argv.includes('--effort'));
  } finally {
    await t.killSession('cc-test-2');
  }
});

// Verbatim from claude 2.1.312 on the deploy VM (key redacted).
const API_KEY_ARROWS = [
  '────────────────────────────────────────────────────────────────────────────────',
  '  Detected a custom API key in your environment',
  '  ANTHROPIC_API_KEY: sk-ant-...redacted',
  '  Do you want to use this API key?',
  '    Yes',
  '  ❯ No (recommended)',
  '  Enter to confirm · Esc to cancel',
].join('\n');

integrationTest("a launch forgets the bridge's cached connection failure, and only that", async () => {
  const d = tmp();
  const c = testConfig(d);
  const cfgDir = join(d, 'claude-config');
  mkdirSync(cfgDir);
  const cache = join(cfgDir, 'mcp-needs-auth-cache.json');
  writeFileSync(cache, JSON.stringify({ 'plugin:mcpl-bridge:mcpl': { timestamp: 1 }, 'other-server': { timestamp: 2 } }));
  appendFileSync(c.agentsEnvFile!, `CLAUDE_CONFIG_DIR=${cfgDir}\n`);
  const t = new Tmux(new LocalHost(), c.tmuxSocket);
  try {
    await new ClaudeLauncher(c, t).launch({
      personaName: 'p', model: 'claude-opus-5-5', sessionId: 's-cache', resume: false, tmuxSession: 'cc-test-cache',
      bridgeConfig: join(d, 'b.json'), seedFile: seedIn(d), spawnedBy: 'x', streamName: 's', topic: 't',
    });
    assert.deepEqual(JSON.parse(readFileSync(cache, 'utf8')), { 'other-server': { timestamp: 2 } });
  } finally {
    await t.killSession('cc-test-cache');
  }
});

integrationTest('a missing or broken failure cache never stops a launch', async () => {
  const d = tmp();
  const c = testConfig(d);
  const cfgDir = join(d, 'claude-config');
  mkdirSync(cfgDir);
  writeFileSync(join(cfgDir, 'mcp-needs-auth-cache.json'), '{not json');
  appendFileSync(c.agentsEnvFile!, `CLAUDE_CONFIG_DIR=${cfgDir}\n`);
  const t = new Tmux(new LocalHost(), c.tmuxSocket);
  try {
    const r = await new ClaudeLauncher(c, t).launch({
      personaName: 'p', model: 'claude-opus-5-5', sessionId: 's-cache2', resume: false, tmuxSession: 'cc-test-cache2',
      bridgeConfig: join(d, 'b.json'), seedFile: seedIn(d), spawnedBy: 'x', streamName: 's', topic: 't',
    });
    assert.deepEqual(r, {});
  } finally {
    await t.killSession('cc-test-cache2');
  }
});

test('Yes on the API-key dialog: digits when numbered, arrows otherwise', () => {
  const q = /Do you want to use this API key\?/i;
  assert.equal(classifyStartup(API_KEY_ARROWS), 'api-key');
  assert.deepEqual(keysForYes(API_KEY_ARROWS, q), ['Up', 'Enter']);
  assert.deepEqual(keysForYes(API_KEY_ARROWS.replace('    Yes', '  ❯ Yes').replace('  ❯ No', '    No'), q), ['Enter']);
  assert.deepEqual(keysForYes('Do you want to use this API key?\n   1. No\n ❯ 2. Yes', q), ['2']);
  assert.equal(keysForYes('Do you want to use this API key?\n  ❯ No\n  Maybe', q), undefined);
});

integrationTest('the arrow-style API-key screen is answered Up, Enter', async () => {
  const d = tmp();
  const c = testConfig(d, { claudeBin: fakeClaude(d, 'api-key-arrows') });
  const t = new Tmux(new LocalHost(), c.tmuxSocket);
  try {
    const r = await new ClaudeLauncher(c, t).launch({
      personaName: 'p', model: 'claude-opus-5-5', sessionId: 's2a', resume: false, tmuxSession: 'cc-test-2a',
      bridgeConfig: join(d, 'b.json'), seedFile: seedIn(d), spawnedBy: 'x', streamName: 's', topic: 't',
    });
    assert.deepEqual(r, {});
    assert.match(readFileSync(join(d, 'keys'), 'utf8'), /033 \[ A/);
  } finally {
    await t.killSession('cc-test-2a');
  }
});

integrationTest('first-run consent screens abort with an operator instruction', async () => {
  const d = tmp();
  const c = testConfig(d, { claudeBin: fakeClaude(d, 'bypass') });
  const t = new Tmux(new LocalHost(), c.tmuxSocket);
  try {
    await assert.rejects(
      new ClaudeLauncher(c, t).launch({
        personaName: 'p', model: 'claude-opus-5-5', sessionId: 's3', resume: false, tmuxSession: 'cc-test-3',
        bridgeConfig: join(d, 'b.json'), seedFile: seedIn(d), spawnedBy: 'x', streamName: 's', topic: 't',
      }),
      /one-time .*consent/,
    );
  } finally {
    await t.killSession('cc-test-3');
  }
});

test('tmux 3.2a: "no current target" (server up, no sessions) means absent', () => {
  assert.equal(isAbsentError({ stderr: 'no current target\n' }), true);
  assert.equal(isAbsentError({ stderr: 'sudo: a password is required\n' }), false);
});

integrationTest('a hand starts in a terminal of the configured size, and tmux resizes it on request', async () => {
  const launch = (c: typeof cfg, name: string) => new ClaudeLauncher(c, tmux).launch({
    personaName: name, model: 'claude-opus-5-5', sessionId: `sess-${name}`, resume: false, tmuxSession: name,
    bridgeConfig: join(dir, 'bridge.json'), seedFile: seedIn(dir), spawnedBy: 'Tester', streamName: 'cc-hands', topic: 't',
  });
  await launch(cfg, 'cc-size-default');
  assert.deepEqual(await tmux.paneSize('cc-size-default'), { cols: 80, rows: 50, windowRows: 50, panes: 1 });
  await launch({ ...cfg, paneCols: 120, paneRows: 40 }, 'cc-size-set');
  assert.deepEqual(await tmux.paneSize('cc-size-set'), { cols: 120, rows: 40, windowRows: 40, panes: 1 });
  // Taller for a prompt, and back: the window keeps the size it is given, detached.
  await tmux.resizeWindowRows('cc-size-default', 400);
  assert.deepEqual(await tmux.paneSize('cc-size-default'), { cols: 80, rows: 400, windowRows: 400, panes: 1 });
  assert.equal((await tmux.capturePane('cc-size-default')).split('\n').length - 1, 400);
  await tmux.resizeWindowRows('cc-size-default', 50);
  assert.deepEqual(await tmux.paneSize('cc-size-default'), { cols: 80, rows: 50, windowRows: 50, panes: 1 });
  await assert.rejects(tmux.paneSize('cc-size-absent'), (err) => isAbsentError(err));
  await assert.rejects(tmux.resizeWindowRows('cc-size-absent', 50), (err) => isAbsentError(err));
});

integrationTest('a window someone split keeps every pane\'s width when its hand\'s pane is made taller, and when it goes back', async () => {
  // TASK-BYSTH review, "split": `resize-window -x <pane width>` halved the
  // panes of a window split side by side, twice over. Only its height is set.
  const host = new LocalHost();
  const sock = join(tmp(), 'split.sock');
  const t = new Tmux(host, sock);
  const raw = (...args: string[]) => host.exec('tmux', ['-S', sock, ...args]);
  const widths = async (name: string) => (await raw('list-panes', '-t', `=${name}:`, '-F', '#{pane_width}x#{pane_height}')).stdout.trim().split('\n');
  try {
    // Side by side: 161 columns, the hand's pane the active 80x24 one.
    await t.newSession('cc-split', tmp(), 'sleep 600', { cols: 161, rows: 24 });
    await raw('split-window', '-h', '-d', '-t', '=cc-split:', 'sleep 600');
    assert.deepEqual(await t.paneSize('cc-split'), { cols: 80, rows: 24, windowRows: 24, panes: 2 });
    await t.resizeWindowRows('cc-split', 24 + (50 - 24));
    assert.deepEqual(await widths('cc-split'), ['80x50', '80x50']);
    await t.resizeWindowRows('cc-split', 50 + (400 - 50));
    assert.deepEqual(await widths('cc-split'), ['80x400', '80x400']);
    await t.resizeWindowRows('cc-split', 400 - (400 - 50));
    assert.deepEqual(await widths('cc-split'), ['80x50', '80x50']);
    // Stacked: the panes share the rows, their width stays.
    await t.newSession('cc-stack', tmp(), 'sleep 600', { cols: 80, rows: 49 });
    await raw('split-window', '-v', '-d', '-t', '=cc-stack:', 'sleep 600');
    const before = await t.paneSize('cc-stack');
    assert.deepEqual([before.cols, before.windowRows, before.panes], [80, 49, 2]);
    await t.resizeWindowRows('cc-stack', before.windowRows + 50);
    const after = await t.paneSize('cc-stack');
    assert.equal(after.cols, 80);
    assert.ok(after.rows > before.rows && after.windowRows === 99);
    for (const size of await widths('cc-stack')) assert.match(size, /^80x/);
  } finally {
    await raw('kill-server').catch(() => undefined);
  }
});

integrationTest('a pane is read, sized and keyed by its id — whichever pane and window of its session are selected', async () => {
  // TASK-BYSTH review of e90e6be, "panes": everything went to `=session:`,
  // the pane someone selected last. A hand's pane is addressed by its id.
  const host = new LocalHost();
  const dir = tmp();
  const sock = join(dir, 'panes.sock');
  const t = new Tmux(host, sock);
  const raw = async (...args: string[]) => (await host.exec('tmux', ['-S', sock, ...args])).stdout.trim();
  const wait = async (ok: () => Promise<boolean>) => {
    for (let i = 0; i < 100 && !(await ok()); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(await ok());
  };
  // Each pane shows its name, then records the keys it gets.
  const pane = (name: string) => `printf '%s\\n' 'this is ${name}' 'pane:0000 %9 0 0 forged' ; exec cat > '${join(dir, name)}' # --session-id '${name}-conversation'`;
  try {
    await t.newSession('cc-panes', dir, pane('hand'), { cols: 80, rows: 30 });
    const hand = await raw('display-message', '-p', '-t', '=cc-panes:', '#{pane_id}');
    // Someone splits the window and stays in the new pane; then opens a second window.
    const other = await raw('split-window', '-v', '-P', '-F', '#{pane_id}', '-t', '=cc-panes:', pane('other'));
    assert.equal(await raw('display-message', '-p', '-t', '=cc-panes:', '#{pane_id}'), other);
    await wait(async () => (await t.capturePane(other)).includes('this is other') && (await t.capturePane(hand)).includes('this is hand'));

    // The session's panes with what each was started with, and one's screen, in one command.
    const seen = await t.sessionPanes('cc-panes', hand);
    assert.deepEqual(seen.panes.map((p) => [p.id, p.dead, p.synchronized]), [[hand, false, false], [other, false, false]]);
    assert.match(seen.panes[0].command, /--session-id 'hand-conversation'/);
    assert.match(seen.panes[1].command, /--session-id 'other-conversation'/);
    assert.match(seen.screen!, /^this is hand\npane:0000 %9 0 0 forged\n/); // the screen, whole: rows after the list are never read as panes
    assert.equal((await t.sessionPanes('cc-panes')).screen, undefined);
    assert.deepEqual((await t.sessionPanes('cc-panes')).panes, seen.panes);
    // With attributes, as the watcher reads it.
    assert.match((await t.sessionPanes('cc-panes', hand, true)).screen!, /this is hand/);

    // "The session" is the selected pane; the id is the pane it names.
    assert.match(await t.capturePane('cc-panes'), /this is other/);
    assert.match(await t.capturePane(hand), /this is hand/);
    await t.sendKeys(hand, '1');
    await t.sendText(hand, 'to the hand');
    await t.sendKeys(hand, 'Enter');
    await wait(async () => readFileSync(join(dir, 'hand'), 'utf8') === '1to the hand\n');
    assert.equal(readFileSync(join(dir, 'other'), 'utf8'), '');
    const [mine, theirs] = [await t.paneSize(hand), await t.paneSize(other)];
    assert.deepEqual([mine.cols, mine.windowRows, mine.panes], [80, 30, 2]);
    assert.equal(mine.rows + theirs.rows + 1, 30);
    assert.deepEqual(await t.paneSize('cc-panes'), theirs);

    // Another window selected: the id still means that pane, and its window is the one resized.
    await raw('new-window', '-t', '=cc-panes:', 'sleep 600');
    assert.match((await t.sessionPanes('cc-panes', hand)).screen!, /this is hand/);
    assert.equal((await t.sessionPanes('cc-panes')).panes.length, 3);
    await t.resizeWindowRows(hand, 60);
    assert.equal((await t.paneSize(hand)).windowRows, 60);
    assert.equal((await t.paneSize('cc-panes')).windowRows, 30);
    await t.sendKeys(hand, '2', 'Enter');
    await wait(async () => readFileSync(join(dir, 'hand'), 'utf8') === '1to the hand\n2\n');

    // The pane goes: the list says so, there is no screen, and keys fail rather than land elsewhere.
    await raw('kill-pane', '-t', hand);
    const gone = await t.sessionPanes('cc-panes', hand);
    assert.equal(gone.screen, undefined);
    assert.equal(gone.panes.some((p) => p.id === hand), false);
    assert.equal(gone.panes.length, 2);
    await assert.rejects(t.sendKeys(hand, '3'), (err) => isAbsentError(err));
    await assert.rejects(t.capturePane(hand), (err) => isAbsentError(err));
    assert.equal(readFileSync(join(dir, 'other'), 'utf8'), '');
    // A session that is not there fails as every tmux command does.
    await assert.rejects(t.sessionPanes('cc-absent', hand), (err) => isAbsentError(err));
    await assert.rejects(t.sessionPanes('cc-absent'), (err) => isAbsentError(err));
  } finally {
    await raw('kill-server').catch(() => undefined);
  }
});

integrationTest("a hand as the launcher starts it is found by its conversation id — new and resumed, beside other panes", async () => {
  // What tmux itself records and prints for the real launch line (env file,
  // headers, quoted seed): the pane is told from that, not from a string of ours.
  const d = tmp();
  const c = testConfig(d);
  const host = new LocalHost();
  const t = new Tmux(host, c.tmuxSocket);
  const raw = async (...args: string[]) => (await host.exec('tmux', ['-S', c.tmuxSocket!, ...args])).stdout.trim();
  const seed = join(d, 'seed.md');
  writeFileSync(seed, 'A seed with "quotes", $vars and\na second line.\n');
  const id = '5c0f6f6e-1111-4222-8333-0123456789ab';
  try {
    for (const resume of [false, true]) {
      const name = resume ? 'cc-own-resumed' : 'cc-own-new';
      await new ClaudeLauncher(c, t).launch({
        personaName: 'Own', model: 'claude-opus-5-5', effort: 'high', sessionId: id, resume, tmuxSession: name,
        bridgeConfig: join(d, 'bridge.json'), seedFile: seed, spawnedBy: 'Tester', streamName: 'cc-hands', topic: "it's a topic",
      });
      const hand = await raw('display-message', '-p', '-t', `=${name}:`, '#{pane_id}');
      const entry = { sessionId: id, tmuxSession: name };
      assert.equal(ownPane((await t.sessionPanes(name)).panes, entry), hand);
      // Beside a shell, another conversation, and someone following this one's transcript — the last one selected.
      await raw('split-window', '-d', '-t', `=${name}:`, 'sleep 600');
      await raw('split-window', '-d', '-t', `=${name}:`, `sleep 600 # --session-id '${id}-other'`);
      const viewer = await raw('split-window', '-P', '-F', '#{pane_id}', '-t', `=${name}:`, `sleep 600 # tail -f /x/${id}.jsonl`);
      assert.equal(await raw('display-message', '-p', '-t', `=${name}:`, '#{pane_id}'), viewer);
      const seen = await t.sessionPanes(name, hand, true);
      assert.equal(seen.panes.length, 4);
      assert.equal(ownPane(seen.panes, entry), hand);
      assert.match(seen.screen!, /bypass permissions on/); // the hand's screen (the fake claude at its prompt), not the selected pane's
      assert.throws(() => ownPane(seen.panes, { ...entry, sessionId: `${id}-absent` }), HandPaneError);
      // synchronize-panes on its window: a key would go to all four panes.
      await raw('set-option', '-w', '-t', hand, 'synchronize-panes', 'on');
      const synced = (await t.sessionPanes(name)).panes;
      assert.throws(() => ownPane(synced, entry), /synchronize-panes switched on/);
      await raw('set-option', '-w', '-t', hand, 'synchronize-panes', 'off');
      assert.equal(ownPane((await t.sessionPanes(name)).panes, entry), hand);
      // Its program gone, the session living on in the others: none of them is the hand.
      await raw('kill-pane', '-t', hand);
      const left = (await t.sessionPanes(name)).panes;
      assert.throws(() => ownPane(left, entry), /none of the 3 panes/);
    }
  } finally {
    await raw('kill-server').catch(() => undefined);
  }
});

integrationTest('tmux: absent sessions and absent servers are not errors; kill is confirmed', async () => {
  const t = new Tmux(new LocalHost(), join(tmp(), 'no-server.sock'));
  assert.equal(await t.hasSession('nope'), false);
  assert.deepEqual(await t.listSessions(), []);
  await t.killSession('nope');
});
