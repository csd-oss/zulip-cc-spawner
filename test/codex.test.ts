import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CodexLauncher, codexArgs, codexScreen, discoverRollout, inferEngine, queueArgs, queueCodex, QUEUE_FAILURE } from '../src/codex.js';
import { CodexWake, addressed } from '../src/codex-wake.js';
import { handName } from '../src/names.js';
import { LocalHost } from '../src/host.js';
import { Registry, type BotEntry } from '../src/registry.js';
import type { ZulipMessage } from '../src/zulip.js';
import type { Tmux } from '../src/tmux.js';
import type { LaunchRequest } from '../src/launcher.js';
import { testConfig, tmp } from './helpers.js';

const cfg = testConfig(tmp());
const req: LaunchRequest = { personaName: '[cx-gpt-5] test', model: 'gpt-5', sessionId: '', resume: false,
  tmuxSession: 'cx-gpt-5-test', bridgeConfig: '/tmp/hand/mcpl-bridge.json', seedFile: '/tmp/seed', spawnedBy: 'Tester',
  streamName: 'test', topic: 'topic', workDir: '/tmp/work' };
const id = '12345678-1234-1234-1234-123456789abc';

test('engine and name inference keep Claude default', () => {
  assert.equal(inferEngine('gpt-5'), 'codex');
  assert.equal(inferEngine('opus-5-5'), 'claude');
  assert.equal(handName('gpt-5', 'Scout').personaName, '[cx-gpt-5/d] Scout');
  assert.equal(handName('opus-5-5', 'Scout').personaName, '[cc-opus-5-5/d] Scout');
});
test('Codex argv: MCP env matches Claude transport; dash literals are values', () => {
  const args = codexArgs(cfg, { ...req, model: '-model', effort: 'high' });
  assert.ok(args.includes('--model=-model'));
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes('mcp_servers.zulip.command=' + JSON.stringify(cfg.nodeBin)));
  assert.match(args.join(' '), /ZULIP_RC_PATH="\/tmp\/hand\/zuliprc"/);
  assert.deepEqual(args.join(' ').match(/ZULIP_UPLOAD_ROOTS="([^"]+)"/g), [`ZULIP_UPLOAD_ROOTS="work=${req.workDir}"`]);
  assert.match(args.join(' '), /MCPL_ENABLED="false"/);
  assert.deepEqual(queueArgs('-thread', '-text $(touch nope)'), ['--thread=-thread', '--message=-text $(touch nope)']);
  assert.equal(args.at(-1), '--');
});
test('Codex omits upload roots when the recorded workspace is unknown, including resume', () => {
  for (const resume of [false, true]) {
    const args = codexArgs(cfg, { ...req, workDir: undefined, resume, sessionId: id });
    assert.ok(!args.some(arg => arg.includes('ZULIP_UPLOAD_ROOTS')));
  }
});
test('resume with id vs fresh without id', () => {
  assert.equal(codexArgs(cfg, { ...req, resume: true, sessionId: id })[0], 'resume');
  assert.deepEqual(codexArgs(cfg, { ...req, resume: true, sessionId: id }).slice(-2), ['--', id]);
  assert.equal(codexArgs(cfg, { ...req, resume: true, sessionId: '' })[0], '--dangerously-bypass-approvals-and-sandbox');
});
test('startup prompts prioritize login and gates over composer', () => {
  for (const [pane, screen] of [['Sign in with ChatGPT', 'login'], ['Do you trust this folder', 'trust'],
    ['Use existing model', 'deprecated'], ['Press enter to continue', 'enter'], ['› hello', 'ready'], ['', 'unknown']]) {
    assert.equal(codexScreen(pane), screen);
  }
});
test('discovery filters start time and cwd, ignores malformed, refuses ambiguous rollouts', async () => {
  const root = tmp();
  const host = new LocalHost();
  const put = (name: string, cwd: string, timestamp: number, sessionId = id) =>
    writeFileSync(join(root, 'rollout-' + name + '.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd, timestamp: new Date(timestamp).toISOString() } }));
  const discover = async () => (await host.exec(process.execPath, ['-e',
    `const __name=(f)=>f; console.log((${discoverRollout.toString()})(...JSON.parse(process.argv[1]))??'')`,
    JSON.stringify([root, 2000, '/tmp/work'])])).stdout.trim();
  put('old', '/tmp/work', 1000);
  put('other', '/tmp/other', 5000);
  writeFileSync(join(root, 'rollout-bad.jsonl'), '{');
  assert.equal(await discover(), '');
  put('match', '/tmp/work', 3000);
  assert.equal(await discover(), id);
  put('ambiguous', '/tmp/work', 3000, 'aaaaaaaa-1234-1234-1234-123456789abc');
  assert.equal(await discover(), '');
});
test('launch production path discovers and returns session; resume retains id; login reports immediately', async () => {
  const local = { ...cfg, agentsHome: tmp() };
  const root = join(local.agentsHome, '.codex/sessions/2026/11/04');
  mkdirSync(root, { recursive: true });
  const tmux = {
    async newSession(_s: string, cwd: string, command: string) {
      assert.equal(cwd, req.workDir);
      assert.match(command, /mcp_servers.zulip/);
      assert.ok(command.includes('model_reasoning_effort="ultra"'));
      writeFileSync(join(root, 'rollout-test.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id, cwd, timestamp: new Date().toISOString() } }));
    },
    async hasSession() { return true; }, async capturePane() { return 'Ask Codex to do anything'; },
  } as unknown as Tmux;
  const launcher = new CodexLauncher(local, tmux, new LocalHost());
  assert.equal((await launcher.launch({ ...req, model: 'gpt-6.1-sol', effort: 'ultra' })).sessionId, id);
  assert.equal((await launcher.launch({ ...req, effort: 'ultra', resume: true, sessionId: id })).sessionId, id);
  tmux.capturePane = async () => 'codex login';
  await assert.rejects(launcher.launch({ ...req, model: 'gpt-6.1-sol', effort: 'ultra' }), /needs login/);
});
test('queue production runner uses hand env and literal argv, no shell text evaluation', async () => {
  const dir = tmp();
  const bin = join(dir, 'fake-codex');
  const output = join(dir, 'argv.json');
  writeFileSync(bin, '#!/usr/bin/env node\nrequire("fs").writeFileSync(' + JSON.stringify(output) + ', JSON.stringify({args:process.argv.slice(2),home:process.env.HOME,custom:process.env.CUSTOM_TEST}));', { mode: 0o700 });
  const env = join(dir, 'env');
  writeFileSync(env, 'CUSTOM_TEST=works\n');
  await queueCodex(new LocalHost(), { ...cfg, codexBin: bin, agentsEnvFile: env }, '-id', '-text $(false)');
  const { readFileSync } = await import('node:fs');
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), {
    args: ['queue', '--thread=-id', '--message=-text $(false)'], home: cfg.agentsHome, custom: 'works',
  });
});
test('wake checks hand flags/home, serializes, attributes and emits only fixed failures', async () => {
  const registry = new Registry(join(tmp(), 'registry.json'));
  const e = { engine: 'codex', status: 'alive', streamId: 7, streamName: 'test', topic: 'topic', botUserId: 42, sessionId: id } as BotEntry;
  registry.add(e);
  const m = { id: 1, type: 'stream', stream_id: 7, subject: 'topic', sender_id: 1, sender_full_name: 'Tester', content: '-hello', flags: ['mentioned'] } as ZulipMessage;
  assert.ok(addressed(e, m));
  assert.equal(addressed(e, { ...m, flags: [] }), false);
  assert.equal(addressed(e, { ...m, subject: 'elsewhere' }), false);
  assert.equal(addressed(e, { ...m, sender_id: 42 }), false);
  const posts: string[] = [], texts: string[] = [];
  let inFlight = 0;
  const wake = new CodexWake(registry, { async postHome(_e, text) { posts.push(text); return 1; }, async reply() {}, async dm() {} },
    async (_e, n) => ({ ...m, id: n }), async (_e, text) => {
      assert.equal(inFlight++, 0); texts.push(text); await Promise.resolve(); inFlight--;
      if (texts.length === 2) throw new Error('/secret/path raw command');
    }, async () => {});
  wake.onMessage({ ...m, flags: [] }); // spawner flags irrelevant
  wake.onMessage({ ...m, id: 2 });
  await wake.drain();
  assert.equal(texts.length, 2);
  assert.match(texts[0], /From Tester in #test > topic:\n-hello/);
  assert.deepEqual(posts, [QUEUE_FAILURE]);
});

test('explicit engine grammar and effort override', async () => {
  const { parseCommand } = await import('../src/commands.js');
  assert.deepEqual(parseCommand('spawn other engine=codex effort=minimal'), {
    kind: 'spawn', model: 'other', friendly: undefined, effort: 'minimal', engine: 'codex',
  });
  assert.equal(parseCommand('spawn gpt-5 engine=wrong').kind, 'help');
  assert.equal(parseCommand('spawn gpt-5 effort=ultracode').kind, 'help');
});

test('parsed max reaches the production Codex config override unchanged', async () => {
  const { parseCommand } = await import('../src/commands.js');
  for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    const cmd = parseCommand(`spawn ${model} effort=max`);
    assert.equal(cmd.kind, 'spawn');
    if (cmd.kind !== 'spawn') throw new Error('spawn expected');
    for (const resume of [false, true]) {
      const args = codexArgs(cfg, { ...req, model: cmd.model, effort: cmd.effort, resume, sessionId: id });
      const index = args.indexOf('model_reasoning_effort="max"');
      assert.ok(index > 0);
      assert.equal(args[index - 1], '-c');
      assert.ok(args.includes(`--model=${model}`));
    }
  }
});
