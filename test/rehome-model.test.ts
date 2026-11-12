import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { SpawnerActions } from '../src/actions.js';
import { parseCommand } from '../src/commands.js';
import type { Where } from '../src/auth.js';
import type { SpawnerConfig } from '../src/config.js';
import { LocalHost } from '../src/host.js';
import { LiveModelSwitcher } from '../src/model-switch.js';
import { buildCommand, type ClaudeLauncher, type LaunchRequest } from '../src/launcher.js';
import { codexArgs } from '../src/codex.js';
import type { Provisioner } from '../src/provision.js';
import { Registry, type BotEntry } from '../src/registry.js';
import type { Tmux } from '../src/tmux.js';
import { TranscriptWatcher } from '../src/transcript-watch.js';
import { testConfig, tmp } from './helpers.js';
import { CLAUDE_CONFIRM, CLAUDE_CHANGED, CODEX_MODELS, CODEX_REASONING, CODEX_CHANGED } from './model-fixtures.js';

const home: Where = { kind: 'stream', streamName: 'cc-hands', streamId: 7, topic: 'old' };
const elsewhere: Where = { kind: 'stream', streamName: 'elsewhere', streamId: 8, topic: 'new' };
function fixture(overrides: Partial<SpawnerConfig> = {}) {
  const dir = tmp();
  const config = testConfig(dir, { allowedUsers: [1, 2, 9, 10], allowedStreams: ['*'], ...overrides });
  const registry = new Registry(join(dir, 'registry.json'));
  const launches: LaunchRequest[] = [];
  const subscriptions: [number, string][] = [];
  const renames: [number, string][] = [];
  const posts: { streamName: string; topic: string; content: string }[] = [];
  const keys: string[][] = [];
  const texts: string[] = [];
  const state = { running: false, warning: undefined as string | undefined, failLaunch: false, failRename: false, failSubscribe: false, existingBot: false,
    panes: ['? for shortcuts'], capture: 0, codexCommand: '', escaped: false };
  const host = new LocalHost();
  const tmux = {
    async hasSession() { return state.running; },
    async listSessions() { return []; },
    async killSession() { state.running = false; },
    async newSession(_s: string, _cwd: string, cmd: string) { state.codexCommand = cmd; state.running = true; },
    async capturePane() { return state.escaped ? 'Ask Codex to do anything\n? for shortcuts' : state.panes[Math.min(state.capture++, state.panes.length - 1)]; },
    async sendKeys(_s: string, ...k: string[]) { keys.push(k); if (k.includes('Escape')) state.escaped = true; },
    async sendText(_s: string, text: string) { texts.push(text); state.escaped = false; },
  } as unknown as Tmux;
  const notifier = { async postHome(e: { streamName: string; topic: string }, content: string) { posts.push({ ...e, content }); return 1; }, async dm() {}, async reply() {} };
  const watcher = new TranscriptWatcher(registry, host, tmux, notifier, config, () => 'spawner');
  const launcher = { async launch(req: LaunchRequest) {
    launches.push(req);
    if (state.failLaunch) throw new Error('launch refused');
    state.running = true;
    return { warning: state.warning };
  } } as unknown as ClaudeLauncher;
  const provisioner = {
    async ensure(_full: string, short: string) { return { bot: { userId: 42, email: `${short}-bot@x`, apiKey: 'offline' }, created: !state.existingBot && registry.all().length === 1 }; },
    async subscribe(id: number, stream: string) { if (state.failSubscribe) throw new Error('subscription refused'); subscriptions.push([id, stream]); },
    async rename(id: number, name: string) { if (state.failRename) throw new Error('rename refused'); renames.push([id, name]); },
    credsFor() { return { email: 'hand-bot@x', key: 'offline', site: 'https://offline.invalid' }; },
  } as unknown as Provisioner;
  const actions = new SpawnerActions({ config, registry, host, tmux, launcher, provisioner, notifier, watcher,
    groupCheck: async () => false, realm: 'offline', codexBoundary: async () => 100,
    modelSwitcher: new LiveModelSwitcher(tmux, async () => {}),
  });
  const run = (body: string, where = home, userId = 1) => actions.run({ body, cmd: parseCommand(body), where, invoker: { kind: 'user', userId, name: `User ${userId}` } });
  function prior(patch: Partial<BotEntry> = {}) {
    const e: BotEntry = {
      suffix: 'scout', personaName: '[cc-sonnet-5-5] Scout', nameScheme: 'stable-v2', harness: 'cc', engine: 'claude',
      tmuxSession: 'cc-scout', handDir: join(dir, 'hand-files', 'cc-scout'), workDir: join(dir, 'kept-work'), workDirReady: true,
      botUserId: 42, botEmail: 'cc-scout-bot@x', streamName: 'cc-hands', streamId: 7, topic: 'old',
      model: 'claude-sonnet-5-5', effort: 'high', sessionId: '12345678-1234-1234-1234-123456789abc', status: 'reaped',
      spawnedBy: { userId: 1, username: 'Creator' }, spawnedAt: new Date().toISOString(), lastActivity: new Date().toISOString(), seedFile: join(dir, 'seed.md'),
      ...patch,
    };
    mkdirSync(e.workDir ?? config.projectDir, { recursive: true });
    writeFileSync(join(e.workDir ?? config.projectDir, 'keep.txt'), 'work');
    if (e.engine !== 'codex') {
      const path = watcher.transcriptPath(e.sessionId, e.workDir);
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, '{}\n');
    }
    registry.add(e);
    return e;
  }
  return { host, actions, config, dir, registry, launches, subscriptions, renames, posts, state, keys, texts, prior, run };
}

for (const user of [1, 9]) for (const model of ['sonnet-5-5', 'opus-5-5']) test(`user ${user} rehomes and resumes with ${model}, retaining creator, bot, paths, transcript`, async () => {
  const f = fixture();
  const before = f.prior();
  f.subscriptions.push([42, 'cc-hands']); // previous subscription must never be removed
  const result = await f.run(`spawn ${model} name=scout`, elsewhere, user);
  assert.match(result.content, /Revived/);
  const e = f.registry.alive()[0];
  assert.equal(e.streamId, 8); assert.equal(e.streamName, 'elsewhere'); assert.equal(e.topic, 'new');
  assert.equal(e.spawnedBy?.userId, 1);
  for (const field of ['botUserId', 'botEmail', 'tmuxSession', 'workDir', 'handDir', 'sessionId'] as const) assert.equal(e[field], before[field], field);
  assert.deepEqual(f.subscriptions, [[42, 'cc-hands'], [42, 'elsewhere']]);
  assert.equal(f.launches[0].resume, true); assert.equal(f.launches[0].model, `claude-${model}`);
  assert.match(buildCommand(f.config, f.launches[0]), /--resume.*--model/);
  assert.equal(e.transcriptOffset, 3);
  assert.equal(readFileSync(join(e.workDir!, 'keep.txt'), 'utf8'), 'work');
  assert.deepEqual(JSON.parse(readFileSync(join(e.handDir, 'mcpl-bridge.json'), 'utf8')).servers.zulip.openChannels, ['zulip:elsewhere']);
  assert.deepEqual(JSON.parse(readFileSync(join(e.handDir, 'zulip-state/filters.json'), 'utf8')), { streams: ['elsewhere'] });
  assert.match(readFileSync(e.seedFile, 'utf8'), /#elsewhere > new/);
  assert.equal(f.renames.length, model === 'opus-5-5' ? 1 : 0);
  assert.equal(e.model, `claude-${model}`);
  const persisted = new Registry(join(f.dir, 'registry.json')); persisted.load();
  assert.equal(persisted.alive()[0].streamId, 8);
});

for (const where of [elsewhere, { ...home, topic: 'changed' }]) for (const model of ['sonnet-5-5', 'opus-5-5']) test(`noncreator cannot rehome/topic/remodel (${where.topic}, ${model})`, async () => {
  const f = fixture(); const e = f.prior();
  assert.match((await f.run(`spawn ${model} name=scout`, where, 2)).content, /Only this hand's creator/);
  assert.equal(f.launches.length, 0); assert.deepEqual(f.renames, []); assert.deepEqual(f.subscriptions, []);
  assert.equal(f.registry.all().length, 1); assert.equal(e.topic, 'old');
});

test('noncreator may still revive unchanged home/model; creator not transferred', async () => {
  const f = fixture(); f.prior();
  assert.match((await f.run('spawn sonnet-5-5 name=scout', home, 2)).content, /Revived/);
  assert.equal(f.registry.alive()[0].spawnedBy?.userId, 1);
});

test('ownerUserId configurable, and allowedUsers does not implicitly grant ownership', async () => {
  const f = fixture({ ownerUserId: 10 }); f.prior();
  assert.match((await f.run('spawn opus-5-5 name=scout', home, 9)).content, /Only this hand's creator/);
  assert.match((await f.run('spawn opus-5-5 name=scout', home, 10)).content, /Revived/);
  assert.equal(f.registry.alive()[0].spawnedBy?.userId, 1);
});

for (const engine of ['claude', 'codex'] as const) test(`${engine}: cross-engine revival refused even with same suffix`, async () => {
  const f = fixture(); f.prior({ engine, model: engine === 'codex' ? 'gpt-6-sol' : 'claude-sonnet-5-5' });
  assert.match((await f.run(`spawn ${engine === 'codex' ? 'opus-5-5' : 'gpt-6-sol'} name=scout`)).content, /Cannot change engine/);
  assert.deepEqual(f.subscriptions, []); assert.equal(f.launches.length, 0);
});

for (const scheme of ['bracket-v1', undefined] as const) test(`legacy ${scheme ?? 'Claude-Code'} identity survives model change and subsequent revival`, async () => {
  const f = fixture();
  const before = f.prior({ nameScheme: scheme, personaName: scheme ? '[cc-sonnet-5-5] Scout' : 'Claude-Code-sonnet-5-5-scout', tmuxSession: 'cc-sonnet-5-5-scout' });
  assert.match((await f.run('spawn opus-5-5 name=scout')).content, /Revived/);
  assert.equal(f.registry.alive()[0].tmuxSession, before.tmuxSession);
  assert.equal(f.registry.alive()[0].personaName, scheme ? '[cc-opus-5-5] Scout' : 'Claude-Code-opus-5-5-scout');
  await f.run('stop scout');
  assert.match((await f.run('spawn sonnet-5-5 name=scout')).content, /Revived/);
  assert.equal(f.registry.alive()[0].sessionId, before.sessionId);
  assert.equal(f.registry.alive()[0].tmuxSession, before.tmuxSession);
  assert.equal(f.renames.length, 2, 'exact old display-name history must resolve to latest launch of the same identity');
});

test('ambiguous historical suffix is refused rather than guessing a bot', async () => {
  const f = fixture(); f.prior(); f.prior({ tmuxSession: 'cc-other-scout', personaName: '[cc-haiku-4-5] Scout', botUserId: 43 });
  assert.match((await f.run('spawn opus-5-5 name=scout')).content, /Ambiguous/);
  assert.deepEqual(f.subscriptions, []);
});

test('new hand stable names ignore model, model slug, and workdir keeps its identity', async () => {
  const f = fixture();
  assert.match((await f.run('spawn opus-5-5 name=Scout')).content, /Spawned/);
  const e = f.registry.alive()[0];
  assert.equal(e.nameScheme, 'stable-v2'); assert.equal(e.tmuxSession, 'cc-scout'); assert.equal(e.botEmail, 'cc-scout-bot@x');
  assert.equal(e.workDir, join(f.config.projectDir, 'hands/cc-scout'));
  assert.equal(e.personaName, '[cc-opus-5-5] Scout');
});

for (const failure of ['failLaunch', 'failSubscribe', 'warning', 'failRename'] as const) test(`revival model-change ${failure} preserves model truth and handles rename as cosmetic`, async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture(); f.prior();
  if (failure === 'warning') f.state.warning = 'startup not confirmed'; else f.state[failure] = true;
  const result = await f.run('spawn opus-5-5 name=scout');
  const e = f.registry.all().at(-1)!;
  assert.equal(e.model, failure === 'failRename' ? 'claude-opus-5-5' : 'claude-sonnet-5-5');
  assert.deepEqual(f.renames, []);
  assert.equal(e.personaName, '[cc-sonnet-5-5] Scout');
  assert.match(result.content, failure === 'failRename' ? /display-name update failed/ : failure === 'warning' ? /not confirmed/ : /failed/);
});

test('Codex stopped model-change resumes id, passes model and effort every time; workspace unchanged', async () => {
  const f = fixture();
  const e = f.prior({ engine: 'codex', harness: 'cx', model: 'gpt-6-sol', personaName: '[cx-gpt-6-sol] Scout', tmuxSession: 'cx-scout' });
  f.state.panes = ['Ask Codex to do anything'];
  assert.match((await f.run('spawn gpt-6.1-terra name=scout effort=medium', elsewhere)).content, /Revived/);
  assert.equal(f.registry.alive()[0].sessionId, e.sessionId);
  assert.equal(f.registry.alive()[0].model, 'gpt-6.1-terra');
  assert.equal(f.registry.alive()[0].effort, 'medium');
  assert.match(f.state.codexCommand, /'resume'.*'--model=gpt-6.1-terra'.*model_reasoning_effort.*medium/);
  assert.ok(f.state.codexCommand.includes(e.sessionId));
  assert.deepEqual(f.renames, [[42, '[cx-gpt-6-1-terr] Scout']]);
  const args = codexArgs(f.config, { ...f.launches[0], personaName: e.personaName, model: 'gpt-6.1-terra', effort: 'medium', sessionId: e.sessionId,
    resume: true, tmuxSession: e.tmuxSession, bridgeConfig: join(e.handDir, 'mcpl-bridge.json'), seedFile: e.seedFile, streamName: 'elsewhere', topic: 'new', spawnedBy: 'Creator' });
  assert.equal(args[0], 'resume'); assert.ok(args.includes('--model=gpt-6.1-terra')); assert.ok(args.includes(e.sessionId));
});

function live(engine: 'claude' | 'codex' = 'claude') {
  const f = fixture();
  const e = f.prior({ status: 'alive', ...(engine === 'codex' ? { engine, harness: 'cx', personaName: '[cx-gpt-6-sol] Scout', model: 'gpt-6-sol', tmuxSession: 'cx-scout' } : {}) });
  f.state.running = true;
  f.state.panes = engine === 'claude' ? ['? for shortcuts', CLAUDE_CONFIRM, CLAUDE_CHANGED] : ['Ask Codex to do anything', CODEX_MODELS, CODEX_REASONING, CODEX_CHANGED];
  return { ...f, e };
}

for (const engine of ['claude', 'codex'] as const) test(`${engine} live switch keeps process/session/workdir and commits after confirmation`, async () => {
  const f = live(engine); const before = { ...f.e };
  assert.match((await f.run(`model scout ${engine === 'claude' ? 'opus-5-5' : 'gpt-6.1-terra effort=medium'}`)).content, /without stopping/);
  assert.equal(f.launches.length, 0); assert.equal(f.state.running, true);
  assert.equal(f.e.sessionId, before.sessionId); assert.equal(f.e.workDir, before.workDir); assert.equal(f.e.tmuxSession, before.tmuxSession);
  assert.equal(f.e.model, engine === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-terra');
  assert.equal(f.e.effort, engine === 'claude' ? 'high' : 'medium');
  assert.equal(f.renames.length, 1);
});

for (const engine of ['claude', 'codex'] as const) test(`${engine} live cross-engine/unauthorized refusals have no terminal effects`, async () => {
  const f = live(engine);
  const model = engine === 'claude' ? 'opus-5-5' : 'gpt-6.1-terra';
  assert.match((await f.run(`model scout ${model}`, home, 2)).content, /Only this hand's creator/);
  assert.match((await f.run(`model scout ${engine === 'claude' ? 'gpt-6.1-terra' : 'opus-5-5'}`)).content, /Cannot change engine/);
  assert.deepEqual(f.texts, []); assert.deepEqual(f.renames, []);
});

test('live unexpected screen/confirmation failure leaves registry and bot name unchanged', async () => {
  const f = live(); f.state.panes = ['? for shortcuts', 'unexpected'];
  assert.match((await f.run('model scout opus-5-5')).content, /Could not change/);
  assert.equal(f.e.model, 'claude-sonnet-5-5'); assert.equal(f.e.personaName, '[cc-sonnet-5-5] Scout');
  assert.deepEqual(f.renames, []); assert.deepEqual(f.keys.at(-1), ['Escape']);
});

test('live rename failure is warning, not a model rollback', async () => {
  const f = live(); f.state.failRename = true;
  assert.match((await f.run('model scout opus-5-5')).content, /display-name update failed/);
  assert.equal(f.e.model, 'claude-opus-5-5'); assert.equal(f.e.personaName, '[cc-sonnet-5-5] Scout');
});

for (const request of ['model scout effort=medium', 'model scout gpt-absent effort=medium']) test(`${request}: home-topic snapshot, auth numeric answer, reopen/verify/apply`, async () => {
  const f = live('codex'); f.state.panes = ['Ask Codex to do anything', CODEX_MODELS];
  assert.match((await f.run(request, elsewhere)).content, /menu posted/);
  assert.equal(f.posts[0].streamName, 'cc-hands'); assert.equal(f.posts[0].topic, 'old');
  assert.match(f.posts[0].content, /6\. GPT-6.1 Terra/); assert.match(f.posts[0].content, /More entries/);
  assert.equal(f.e.model, 'gpt-6-sol'); assert.equal(f.renames.length, 0);
  assert.deepEqual(f.keys.slice(-2), [['Escape'], ['Escape']]);
  assert.match((await f.run('answer scout 6', home, 2)).content, /Only this hand's creator/);
  assert.match((await f.run('answer scout 999')).content, /posted model numbers/);
  f.state.capture = 0; f.state.panes = ['Ask Codex to do anything', CODEX_MODELS, CODEX_REASONING, CODEX_CHANGED];
  assert.match((await f.run('6')).content, /without stopping/); // existing bare-answer flow
  assert.equal(f.e.model, 'gpt-6.1-terra'); assert.equal(f.e.pendingModelMenu, undefined);
});

test('numeric snapshot choices expire or cancel without touching terminal', async () => {
  const f = live('codex'); f.state.panes = ['Ask Codex to do anything', CODEX_MODELS];
  await f.run('model scout');
  f.e.pendingModelMenu!.postedAt = '2000-01-01T00:00:00Z';
  const count = f.keys.length;
  assert.match((await f.run('answer scout 6')).content, /expired/); assert.equal(f.keys.length, count);
  f.state.capture = 0; await f.run('model scout');
  assert.match((await f.run('answer scout esc')).content, /cancelled/); assert.equal(f.e.pendingModelMenu, undefined);
});

test('subscription failure does not record a successful home move', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture(); f.prior(); f.state.failSubscribe = true;
  assert.match((await f.run('spawn opus-5-5 name=scout', elsewhere)).content, /failed/);
  assert.equal(f.registry.all().at(-1)!.streamId, 7);
  assert.equal(f.registry.all().at(-1)!.topic, 'old');
  assert.deepEqual(f.renames, []);
});

test('owner can live-switch another creator’s hand without transferring ownership', async () => {
  const f = live();
  assert.match((await f.run('model scout opus-5-5', home, 9)).content, /without stopping/);
  assert.equal(f.e.spawnedBy?.userId, 1);
});

test('no running hand, pending question, and live Claude effort have clear refusals', async () => {
  const f = live();
  assert.match((await f.run('model missing opus-5-5')).content, /No running hand/);
  assert.match((await f.run('model scout opus-5-5 effort=high')).content, /stop and spawn/);
  assert.deepEqual(f.texts, []);
  f.e.pendingQuestion = { sig: 'x', postedAt: new Date().toISOString(), questions: [] };
  assert.match((await f.run('model scout opus-5-5')).content, /pending question/);
  assert.deepEqual(f.texts, []);
});

test('Claude numeric menu fallback closes the list and reopens a verified model confirmation', async () => {
  const f = live();
  f.state.panes = ['? for shortcuts', 'Select model\n❯ 1. Sonnet 5.5\n  2. Opus 5.5']; // synthetic list
  assert.match((await f.run('model scout')).content, /menu posted/);
  assert.deepEqual(f.keys.at(-1), ['Escape']);
  assert.match(f.posts[0].content, /2\. Opus 5.5/);
  f.state.panes = ['? for shortcuts', CLAUDE_CONFIRM, CLAUDE_CHANGED]; f.state.capture = 0;
  assert.match((await f.run('answer scout 2')).content, /without stopping/);
  assert.equal(f.e.model, 'claude-opus-5-5');
  assert.deepEqual(f.texts, ['/model', '/model claude-opus-5-5']);
});

for (const failed of [false, true]) test(`missing-author revival (failed=${failed}) never claims ownership`, async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture(); f.prior({ spawnedBy: undefined });
  f.state.failLaunch = failed;
  await f.run('spawn sonnet-5-5 name=scout', home, 2);
  assert.equal(f.registry.all().at(-1)!.spawnedBy, undefined);
  f.state.failLaunch = false;
  if (failed) await f.run('spawn sonnet-5-5 name=scout', home, 2);
  assert.match((await f.run('model scout opus-5-5', home, 2)).content, /creator.*unknown/);
  assert.deepEqual(f.keys, []); assert.deepEqual(f.texts, []);
  await f.run('stop scout');
  for (const [model, where] of [['sonnet-5-5', elsewhere], ['opus-5-5', home]] as const) {
    assert.match((await f.run(`spawn ${model} name=scout`, where, 2)).content, /creator.*unknown/);
  }
  assert.match((await f.run('spawn opus-5-5 name=scout', elsewhere, 9)).content, /Revived/);
  assert.equal(f.registry.alive()[0].spawnedBy, undefined);
});

for (const where of [home, { kind: 'dm' } as Where]) for (const user of [2, 1, 9]) {
  test(`press in ${where.kind} by user ${user} enforces creator/owner for all keys`, async () => {
    const f = live();
    const result = await f.run('press scout /model enter', where, user);
    assert.match(result.content, user === 2 ? /Only this hand's creator/ : /Sent/);
    assert.deepEqual(f.texts, user === 2 ? [] : ['/model']);
    assert.deepEqual(f.keys, user === 2 ? [] : [['Enter']]);
  });
}

for (const stage of ['prepare', 'boundary', 'filters', 'bridge', 'seed', 'launch']) {
  test(`failed rehome at ${stage} restores authoritative home/files and permits old-home retry`, async t => {
    t.mock.method(console, 'error', () => {});
    const f = fixture();
    const codex = stage === 'boundary';
    const before = f.prior(codex ? { engine: 'codex', model: 'gpt-6-sol', harness: 'cx', personaName: '[cx-gpt-6-sol] Scout' } : {});
    const { handPaths, writeHandFiles } = await import('../src/handfiles.js');
    const paths = handPaths(f.config.handsDir, before.tmuxSession, before.handDir);
    await writeHandFiles(f.host, f.config, before.tmuxSession, home.streamName,
      { email: 'hand-bot@x', key: 'offline', site: 'https://offline.invalid' }, 'old seed', before.handDir);
    const files = [paths.filters, paths.bridgeConfig, paths.seed];
    const originals = files.map(p => readFileSync(p, 'utf8'));
    f.subscriptions.push([42, home.streamName]);
    const undo: (() => void)[] = [];
    if (stage === 'prepare') {
      const mock = t.mock.method(f.host, 'exec', async () => { throw new Error('prepare failed'); });
      undo.push(() => mock.mock.restore());
    } else if (stage === 'boundary') {
      // Access dependencies solely to inject a boundary failure and verify staged destination.
      const deps = (f.actions as unknown as { d: import('../src/actions.js').ActionDeps }).d;
      deps.codexBoundary = async e => {
        assert.equal(e.streamId, 8);
        assert.equal(f.registry.all().at(-1)!.streamId, 7);
        throw new Error('boundary failed');
      };
      undo.push(() => { deps.codexBoundary = async e => { assert.equal(e.streamId, 7); return 100; }; });
    } else if (['filters', 'bridge', 'seed'].includes(stage)) {
      const target = stage === 'filters' ? paths.filters : stage === 'bridge' ? paths.bridgeConfig : paths.seed;
      const write = f.host.writeFile.bind(f.host);
      let once = true;
      const mock = t.mock.method(f.host, 'writeFile', async (p, content, mode) => {
        await write(p, content, mode); // fail after a partial side effect
        if (p === target && once) { once = false; throw new Error('write failed'); }
      });
      undo.push(() => mock.mock.restore());
    } else f.state.failLaunch = true;
    const model = codex ? 'gpt-6-sol' : 'sonnet-5-5';
    assert.match((await f.run(`spawn ${model} name=scout`, elsewhere)).content, /failed/);
    const failed = f.registry.all().at(-1)!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.streamId, 7); assert.equal(failed.topic, 'old');
    assert.deepEqual(files.map(p => readFileSync(p, 'utf8')), originals);
    assert.deepEqual(f.subscriptions, [[42, home.streamName], [42, elsewhere.streamName]]);
    undo.forEach(fn => fn()); f.state.failLaunch = false;
    if (codex) f.state.panes = ['Ask Codex to do anything'];
    assert.match((await f.run(`spawn ${model} name=scout`, home, 2)).content, /Revived/);
    const revived = f.registry.alive()[0];
    for (const key of ['botUserId', 'botEmail', 'tmuxSession', 'workDir', 'handDir', 'sessionId'] as const) {
      assert.equal(revived[key], before[key], key);
    }
    assert.equal(revived.streamId, 7);
  });
}


test('new identity records creator, but an orphan pre-existing bot does not grant ownership', async () => {
  for (const existingBot of [false, true]) {
    const f = fixture(); f.state.existingBot = existingBot;
    await f.run('spawn sonnet-5-5 name=scout', home, 2);
    assert.equal(f.registry.alive()[0].spawnedBy?.userId, existingBot ? undefined : 2);
  }
});

test('failed rehome removes staged home files that did not previously exist', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture(); const before = f.prior(); f.state.failLaunch = true;
  await f.run('spawn sonnet-5-5 name=scout', elsewhere);
  for (const file of ['mcpl-bridge.json', 'zulip-state/filters.json', 'seed.md']) {
    assert.equal(await f.host.exists(join(before.handDir, file)), false);
  }
  assert.equal(f.registry.all().at(-1)!.streamId, 7);
});
