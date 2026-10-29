import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { LocalHost } from '../src/host.js';
import { ClaudeLauncher, classifyStartup, keysForYes, yesOption } from '../src/launcher.js';
import { isAbsentError, Tmux } from '../src/tmux.js';
import { fakeClaude, testConfig, tmp } from './helpers.js';

const dir = tmp();
const cfg = testConfig(dir);
const tmux = new Tmux(new LocalHost(), cfg.tmuxSocket);
after(async () => {
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

test('launch line: env file sourced, headers set, effort env cleared, seed passed verbatim', async () => {
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

test('the API-key screen is answered with its Yes option', async () => {
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

test("a launch forgets the bridge's cached connection failure, and only that", async () => {
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

test('a missing or broken failure cache never stops a launch', async () => {
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

test('the arrow-style API-key screen is answered Up, Enter', async () => {
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

test('first-run consent screens abort with an operator instruction', async () => {
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

test('tmux: absent sessions and absent servers are not errors; kill is confirmed', async () => {
  const t = new Tmux(new LocalHost(), join(tmp(), 'no-server.sock'));
  assert.equal(await t.hasSession('nope'), false);
  assert.deepEqual(await t.listSessions(), []);
  await t.killSession('nope');
});
