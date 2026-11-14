import { claude323Replay } from './model-replay.js';
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
import { CLAUDE_323_CONFIRM, CLAUDE_323_CHANGED, CLAUDE_CONFIRM, CLAUDE_CHANGED, CODEX_MODELS, CODEX_REASONING, CODEX_CHANGED } from './model-fixtures.js';

const home: Where = { kind: 'stream', streamName: 'cc-hands', streamId: 7, topic: 'old' };
const elsewhere: Where = { kind: 'stream', streamName: 'elsewhere', streamId: 8, topic: 'new' };
function fixture(overrides: Partial<SpawnerConfig> = {}) {
  const dir = tmp();
  const config = testConfig(dir, { allowedUsers: [1, 2, 9, 10], allowedStreams: ['*'], creatorOnlyControls: true, ownerUserId: 9, ...overrides });
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
    async sessionUptime() { return 60; },
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
  return { tmux, host, actions, config, dir, registry, launches, subscriptions, renames, posts, state, keys, texts, prior, run };
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
  assert.equal(JSON.parse(readFileSync(join(e.handDir, 'mcpl-bridge.json'), 'utf8')).servers.zulip.transport.env.ZULIP_UPLOAD_ROOTS, `work=${before.workDir}`);
  assert.deepEqual(JSON.parse(readFileSync(join(e.handDir, 'zulip-state/filters.json'), 'utf8')), { streams: ['elsewhere'] });
  assert.match(readFileSync(e.seedFile, 'utf8'), /#elsewhere > new/);
  assert.equal(f.renames.length, model === 'sonnet-5-5' ? 0 : 1, 'unchanged revival must not modernize the display name');
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
  assert.equal(f.registry.alive()[0].personaName, scheme ? '[cc-opus-5-5/h] Scout' : '[cc-opus-5-5/h] scout');
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
  assert.equal(e.personaName, '[cc-opus-5-5/d] Scout');
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
  assert.ok(f.state.codexCommand.includes(`ZULIP_UPLOAD_ROOTS="work=${e.workDir}"`));
  assert.deepEqual(f.renames, [[42, '[cx-gpt-6-1-terr/med] Scout']]);
  const args = codexArgs(f.config, { ...f.launches[0], personaName: e.personaName, model: 'gpt-6.1-terra', effort: 'medium', sessionId: e.sessionId,
    resume: true, tmuxSession: e.tmuxSession, bridgeConfig: join(e.handDir, 'mcpl-bridge.json'), seedFile: e.seedFile, streamName: 'elsewhere', topic: 'new', spawnedBy: 'Creator' });
  assert.equal(args[0], 'resume'); assert.ok(args.includes('--model=gpt-6.1-terra')); assert.ok(args.includes(e.sessionId));
});

function live(engine: 'claude' | 'codex' = 'claude', overrides: Partial<SpawnerConfig> = {}) {
  const f = fixture(overrides);
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
  assert.deepEqual(f.renames, [[42, engine === 'claude' ? '[cc-opus-5-5/h] Scout' : '[cx-gpt-6-1-terr/med] Scout']]);
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

const ASK_AFTER_MODEL = ' ☐ Choice\nPick one?\n❯ 1. Red\n  2. Blue\n  3. Type something.\n  4. Chat about this';
const PERMISSION_AFTER_MODEL = '──────────────────────────────\n Bash command\n │ destructive-command\n Do you want to proceed?\n ❯ 1. Yes\n 2. No\n Esc to cancel · Tab to amend';

async function closedModelSnapshot() {
  const f = live();
  f.state.panes = ['? for shortcuts', 'Select model\n❯ 1. Sonnet 5.5\n 2. Opus 5.5'];
  assert.match((await f.run('model scout')).content, /menu posted/);
  assert.ok(f.e.pendingModelMenu);
  return f;
}

async function questionAfterModel(pane = ASK_AFTER_MODEL) {
  const f = await closedModelSnapshot();
  f.state.escaped = false; f.state.capture = 0; f.state.panes = [pane];
  await f.run('rescan');
  assert.ok(f.e.pendingQuestion);
  return f;
}

for (const user of [1, 2]) for (const answer of ['answer scout 1', '1']) for (const expired of [false, true]) {
  test(`real question supersedes ${expired ? 'expired' : 'fresh'} model snapshot: user ${user}, ${answer}`, async () => {
    const f = await questionAfterModel();
    if (expired) f.e.pendingModelMenu!.postedAt = '2000-01-01T00:00:00Z';
    const before = f.keys.length;
    assert.match((await f.run(answer, home, user)).content, /Answer sent/);
    assert.deepEqual(f.keys.slice(before), [['1']]);
    assert.equal(f.e.pendingModelMenu, undefined);
    assert.equal(f.e.model, 'claude-sonnet-5-5');
    assert.deepEqual(f.renames, []);
    assert.deepEqual(f.texts, ['/model']); // never reopen a model menu
  });
}

for (const answer of ['answer scout 1', '1']) {
  test(`model snapshot cannot bypass permission ownership: ${answer}`, async () => {
    const f = await questionAfterModel(PERMISSION_AFTER_MODEL);
    const before = f.keys.length;
    assert.match((await f.run(answer, home, 2)).content, /Only this hand's creator/);
    assert.equal(f.keys.length, before);
    assert.equal(f.e.pendingModelMenu, undefined);
    assert.match((await f.run(answer)).content, /Answer sent/);
  });

  test(`question after model snapshot still validates current pane: ${answer}`, async () => {
    const f = await questionAfterModel();
    f.state.panes = [ASK_AFTER_MODEL.replace('Pick one?', 'A different question?')];
    const before = f.keys.length;
    assert.match((await f.run(answer, home, 2)).content, /moved on to a different question/);
    assert.equal(f.keys.length, before);
    assert.equal(f.e.pendingModelMenu, undefined);
  });

  test(`nonowner can expire a model snapshot without terminal writes: ${answer}`, async () => {
    const f = await closedModelSnapshot();
    f.e.pendingModelMenu!.postedAt = '2000-01-01T00:00:00Z';
    const before = f.keys.length;
    assert.match((await f.run(answer, home, 2)).content, /expired/);
    assert.equal(f.keys.length, before);
    assert.equal(f.e.pendingModelMenu, undefined);
  });

  for (const user of [1, 2, 9]) test(`strict-mode model-only snapshot remains owner/creator-only: user ${user}, ${answer}`, async () => {
    const f = await closedModelSnapshot();
    const before = f.keys.length;
    if (user === 2) {
      assert.match((await f.run(answer, home, user)).content, /Only this hand's creator/);
      assert.equal(f.keys.length, before);
      assert.ok(f.e.pendingModelMenu);
    } else {
      f.state.capture = 0; f.state.panes = ['? for shortcuts', CLAUDE_CONFIRM, CLAUDE_CHANGED];
      // The confirmation fixture is for Opus, which is model-menu option 2.
      assert.match((await f.run(answer.replace(/1$/, '2'), home, user)).content, /without stopping/);
      assert.equal(f.e.model, 'claude-opus-5-5');
      assert.equal(f.e.pendingModelMenu, undefined);
    }
  });
}

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
      { email: 'hand-bot@x', key: 'offline', site: 'https://offline.invalid' }, 'old seed', before.handDir, before.workDir);
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

for (const effort of [undefined, 'medium', 'default']) test(`legacy unsuffixed revival with effort=${effort ?? 'inherited'} preserves identity`, async () => {
  const f = fixture(); const before = f.prior();
  assert.equal(f.registry.latestFor('[cc-sonnet-5-5/low] Scout'), before);
  assert.match((await f.run(`spawn sonnet-5-5 name=scout${effort ? ` effort=${effort}` : ''}`)).content, /Revived/);
  const e = f.registry.alive()[0];
  const abbr = effort === 'default' ? 'd' : effort === 'medium' ? 'med' : 'h';
  assert.deepEqual(f.renames, effort ? [[42, `[cc-sonnet-5-5/${abbr}] Scout`]] : []);
  assert.equal(e.effort, effort === 'default' ? undefined : effort ?? 'high');
  for (const field of ['botUserId', 'botEmail', 'tmuxSession', 'workDir', 'handDir', 'sessionId'] as const) assert.equal(e[field], before[field], field);
  assert.equal(f.registry.latestFor(before.personaName), e);
  assert.equal(f.registry.latestFor('[cc-sonnet-5-5/low] Scout'), e);
  assert.equal(f.registry.findAlive('[cc-sonnet-5-5/xh] Scout'), e);
  assert.match((await f.run('spawn sonnet-5-5 name=scout effort=low')).content, /taken/);
  await f.run('stop scout');
  assert.match((await f.run('spawn sonnet-5-5 name=scout effort=low')).content, /Revived/);
  assert.equal(f.registry.alive()[0].personaName, '[cc-sonnet-5-5/low] Scout');
  assert.equal(f.registry.alive()[0].tmuxSession, before.tmuxSession);
});

test('Codex live effort-only change renames without changing model or identity', async () => {
  const f = live('codex'); const before = { ...f.e };
  f.state.panes = ['Ask Codex to do anything', CODEX_MODELS,
    CODEX_REASONING.replace('GPT-6.1 Terra', 'GPT-6-Sol'),
    CODEX_CHANGED.replace('gpt-6.1-terra', 'gpt-6-sol')];
  assert.match((await f.run('model scout gpt-6-sol effort=medium')).content, /without stopping/);
  assert.equal(f.e.model, before.model);
  assert.equal(f.e.effort, 'medium');
  assert.deepEqual(f.renames, [[42, '[cx-gpt-6-sol/med] Scout']]);
  for (const field of ['botUserId', 'botEmail', 'tmuxSession', 'workDir', 'handDir', 'sessionId'] as const) assert.equal(f.e[field], before[field], field);
});

for (const failRename of [false, true]) test(`effort-only revival rename failure=${failRename} preserves launch truth`, async () => {
  const f = fixture();
  const before = f.prior({ personaName: '[cc-sonnet-5-5/h] Scout' });
  f.state.failRename = failRename;
  const result = await f.run('spawn sonnet-5-5 name=scout effort=medium');
  const e = f.registry.alive()[0];
  assert.equal(e.effort, 'medium');
  assert.equal(e.personaName, failRename ? before.personaName : '[cc-sonnet-5-5/med] Scout');
  assert.equal(e.botUserId, before.botUserId);
  if (failRename) assert.match(result.content, /display-name update failed/);
});

test('unconfirmed effort-only revival keeps prior default and display name', async () => {
  const f = fixture(); f.prior({ effort: undefined, personaName: '[cc-sonnet-5-5/d] Scout' });
  f.state.warning = 'startup not confirmed';
  assert.match((await f.run('spawn sonnet-5-5 name=scout effort=medium')).content, /not confirmed/);
  assert.equal(f.registry.alive()[0].effort, undefined);
  assert.equal(f.registry.alive()[0].personaName, '[cc-sonnet-5-5/d] Scout');
  assert.deepEqual(f.renames, []);
});

// Explicit rename is display-only; the stable suffix is intentionally not renamed.
for (const user of [1, 9]) test(`user ${user} renames a live hand without touching terminal, files or continuity`, async () => {
  const f = fixture(); const history = f.prior(); const historical = structuredClone(history);
  await f.run('spawn sonnet-5-5 name=scout');
  const e = f.registry.alive()[0]; const before = structuredClone(e);
  const bridgePath = join(e.handDir, 'mcpl-bridge.json');
  const bridge = readFileSync(bridgePath, 'utf8'); const seed = readFileSync(e.seedFile, 'utf8');
  const launchCount = f.launches.length; const subscriptionCount = f.subscriptions.length;
  const result = await f.run('rename scout Pathfinder', home, user);
  assert.equal(result.content, 'Renamed **[cc-sonnet-5-5] Scout** to **[cc-sonnet-5-5] Pathfinder**. Old names remain aliases; same bot, session, workdir and conversation.');
  assert.deepEqual(f.renames.at(-1), [42, '[cc-sonnet-5-5] Pathfinder']);
  const { personaName, friendlyName, nameAliases, ...unchanged } = e;
  const { personaName: _oldName, ...original } = before;
  assert.deepEqual(unchanged, original, 'only three display/alias fields change');
  assert.equal(friendlyName, 'Pathfinder'); assert.ok(nameAliases?.includes('Scout'));
  assert.equal(f.state.running, true); assert.equal(f.launches.length, launchCount);
  assert.equal(f.subscriptions.length, subscriptionCount); assert.deepEqual(f.keys, []); assert.deepEqual(f.texts, []);
  assert.equal(readFileSync(bridgePath, 'utf8'), bridge); assert.equal(readFileSync(e.seedFile, 'utf8'), seed);
  assert.equal(JSON.parse(bridge).servers.zulip.transport.env.ZULIP_SESSION_ID, before.tmuxSession);
  assert.deepEqual(history, historical, 'earlier launch entry untouched');
  for (const target of ['Pathfinder', 'scout', before.personaName]) assert.equal(f.registry.findAlive(target), e);
  assert.match((await f.run('list')).content, /Pathfinder/);
  assert.match((await f.run('peek Pathfinder')).content, /Pathfinder/);
  assert.match((await f.run('press Pathfinder esc')).content, /Sent `Escape`/);
  assert.match((await f.run('stop Pathfinder')).content, /Stopped/);
});

for (const alias of ['Pathfinder', 'scout', 'Scout']) test(`stopped rename and revival/rehome via ${alias} retain new name and session`, async () => {
  const f = fixture(); const e = f.prior(); const before = structuredClone(e);
  assert.match((await f.run('rename scout Pathfinder')).content, /Renamed/);
  const renamedHistory = structuredClone(e);
  assert.equal(f.state.running, false); assert.equal(f.launches.length, 0);
  const persisted = new Registry(join(f.dir, 'registry.json')); persisted.load();
  assert.equal(persisted.renamedHands('Pathfinder')[0]?.friendlyName, 'Pathfinder');
  assert.match((await f.run(`spawn opus-5-5 name=${alias} effort=medium`, elsewhere)).content, /Revived/);
  const current = f.registry.alive()[0];
  assert.equal(current.personaName, '[cc-opus-5-5/med] Pathfinder');
  assert.equal(current.suffix, 'scout'); assert.equal(current.friendlyName, 'Pathfinder');
  for (const key of ['botUserId', 'botEmail', 'tmuxSession', 'handDir', 'workDir', 'sessionId'] as const) assert.equal(current[key], before[key], key);
  assert.equal(current.topic, 'new'); assert.equal(f.launches[0].resume, true);
  assert.equal(JSON.parse(readFileSync(join(current.handDir, 'mcpl-bridge.json'), 'utf8')).servers.zulip.transport.env.ZULIP_SESSION_ID, before.tmuxSession);
  assert.deepEqual(e, renamedHistory, 'revival appends rather than rewriting old history');
  assert.equal(f.registry.renamedHands(before.personaName)[0], current);
  assert.equal(f.registry.findAlive('Pathfinder'), current); assert.equal(f.registry.findAlive('scout'), current);
  await f.run('stop Pathfinder');
  assert.match((await f.run('spawn sonnet-5-5 name=Pathfinder', elsewhere)).content, /Revived/);
  assert.equal(f.registry.alive()[0].sessionId, before.sessionId);
});

for (const engine of ['claude', 'codex'] as const) test(`${engine} live model/effort rename keeps custom friendly name and aliases`, async () => {
  const f = live(engine); const before = structuredClone(f.e);
  await f.run('rename scout Pathfinder');
  const customName = f.e.personaName;
  assert.match((await f.run(`model Pathfinder ${engine === 'claude' ? 'opus-5-5' : 'gpt-6.1-terra effort=medium'}`)).content, /without stopping/);
  assert.equal(f.e.personaName, engine === 'claude' ? '[cc-opus-5-5/h] Pathfinder' : '[cx-gpt-6-1-terr/med] Pathfinder');
  for (const target of ['scout', 'Pathfinder', before.personaName, customName]) assert.equal(f.registry.findAlive(target), f.e);
  assert.equal(f.state.running, true); assert.equal(f.launches.length, 0);
  for (const key of ['tmuxSession', 'workDir', 'handDir', 'botEmail', 'sessionId'] as const) assert.equal(f.e[key], before[key]);
});

test('repeated and case-only renames retain every old alias without duplicates', async () => {
  const f = live();
  for (const [old, next] of [['scout', 'Pathfinder'], ['Pathfinder', 'Guide'], ['Guide', 'guide'], ['scout', 'Scout']]) {
    assert.match((await f.run(`rename ${old} ${next}`)).content, /Renamed/);
  }
  for (const target of ['scout', 'Pathfinder', 'Guide', 'guide']) assert.equal(f.registry.findAlive(target), f.e);
  assert.equal(f.e.nameAliases?.length, new Set(f.e.nameAliases).size);
});

for (const user of [2, 9, 10]) test(`rename respects configured owner and creator (caller ${user})`, async () => {
  const f = fixture({ ownerUserId: 10 }); const e = f.prior(); const before = structuredClone(e);
  const result = await f.run('rename scout Pathfinder', home, user);
  if (user === 10) assert.match(result.content, /Renamed/);
  else {
    assert.match(result.content, /Only this hand's creator \(user 1\) or the owner \(user 10\) may rename it.*creatorOnlyControls is enabled/);
    assert.deepEqual(e, before); assert.deepEqual(f.renames, []);
  }
});

test('strict mode: unknown historical creator stays unknown; only owner may rename', async () => {
  const f = fixture(); const e = f.prior({ spawnedBy: undefined });
  assert.match((await f.run('rename scout Pathfinder')).content, /creator \(user unknown\)/);
  assert.match((await f.run('rename scout Pathfinder', home, 9)).content, /Renamed/);
  assert.equal(e.spawnedBy, undefined);
});

for (const status of ['alive', 'reaped', 'failed', 'cleanup', 'provisioning'] as const) test(`rename rejects another ${status} hand's current name, suffix and aliases`, async () => {
  const f = live(); const before = structuredClone(f.e);
  f.prior({ suffix: 'other', personaName: '[cc-opus-5-5/h] Taken', friendlyName: 'Taken', nameAliases: ['Reserved'], tmuxSession: 'cc-other', botUserId: 43, status });
  for (const name of ['TAKEN', 'Other', 'reserved', 'cc-other']) {
    assert.match((await f.run(`rename scout ${name}`)).content, /Name collision/);
  }
  assert.deepEqual(f.e, before); assert.deepEqual(f.renames, []);
});

test('unrenamed bracket friendly name is reserved even when different from suffix', async () => {
  const f = live(); f.prior({ suffix: 'other', personaName: '[cc-opus-5-5] Taken', tmuxSession: 'cc-other', botUserId: 43 });
  assert.match((await f.run('rename scout Taken')).content, /Name collision/);
});

test('rename refuses provisioning and missing bot without PATCH or state mutation', async () => {
  for (const patch of [{ status: 'provisioning' as const }, { botUserId: 0, status: 'failed' as const }]) {
    const f = fixture(); const e = f.prior(patch); const before = structuredClone(e);
    assert.match((await f.run('rename scout Pathfinder')).content, /Cannot rename/);
    assert.deepEqual(e, before); assert.deepEqual(f.renames, []);
  }
});

test('rename failure leaves names, aliases and every continuity field unchanged', async () => {
  const f = live(); const before = structuredClone(f.e); f.state.failRename = true;
  assert.equal((await f.run('rename scout Pathfinder')).content, 'Could not rename the Zulip bot; registry name and aliases unchanged. Try again.');
  assert.deepEqual(f.e, before); assert.deepEqual(f.renames, []); assert.deepEqual(f.keys, []);
  assert.equal(f.registry.findAlive('Pathfinder'), undefined);
});

test('rename rejects invalid characters/length and enforces the complete 49-character persona budget', async () => {
  const f = fixture(); const e = f.prior({ personaName: `[${'x'.repeat(27)}] Scout` });
  for (const bad of ['bad_name', 'bad.name', 'bad!', 'a'.repeat(25), 'дві']) {
    assert.match((await f.run(`rename scout ${bad}`)).content, /bad name/);
  }
  assert.equal((await f.run(`rename scout ${'a'.repeat(20)}`)).content, 'Hand name too long — Zulip persona must be at most 49 characters.');
  assert.deepEqual(f.renames, []);
  assert.match((await f.run(`rename scout ${'a'.repeat(19)}`)).content, /Renamed/);
  assert.equal(e.personaName.length, 49);
});

test('legacy pre-bracket hand can rename and revive without changing stable paths', async () => {
  const f = fixture(); const e = f.prior({ personaName: 'Claude-Code-sonnet-5-5-scout', nameScheme: undefined, tmuxSession: 'cc-sonnet-5-5-scout' });
  assert.match((await f.run('rename scout Pathfinder')).content, /Renamed/);
  assert.match((await f.run('spawn sonnet-5-5 name=Pathfinder')).content, /Revived/);
  assert.equal(f.registry.alive()[0].tmuxSession, e.tmuxSession);
  assert.equal(f.registry.alive()[0].sessionId, e.sessionId);
});

test('renamed busy hand cannot be respawned under either name, including another model/engine', async () => {
  const f = live(); await f.run('rename scout Pathfinder');
  for (const name of ['scout', 'Pathfinder']) for (const model of ['opus-5-5', 'gpt-6-sol']) {
    assert.match((await f.run(`spawn ${model} name=${name}`)).content, /is taken/);
  }
  assert.equal(f.launches.length, 0); assert.equal(f.registry.all().length, 1);
});

test('effort-only Codex menu flow preserves custom name', async () => {
  const f = live('codex');
  await f.run('rename scout Pathfinder');
  f.state.panes = ['Ask Codex to do anything', CODEX_MODELS]; f.state.capture = 0;
  assert.match((await f.run('model Pathfinder effort=medium')).content, /menu posted/);
  f.state.capture = 0; f.state.panes = ['Ask Codex to do anything', CODEX_MODELS, CODEX_REASONING, CODEX_CHANGED];
  assert.match((await f.run('answer Pathfinder 6')).content, /without stopping/);
  assert.equal(f.e.friendlyName, 'Pathfinder');
  assert.equal(f.e.personaName, '[cx-gpt-6-1-terr/med] Pathfinder');
});

test('rename via full mention works in a DM, and unknown or ambiguous targets do not PATCH', async () => {
  const f = live();
  assert.equal((await f.run('rename missing Guide')).content, 'No hand matches `missing` — try `list`.');
  assert.deepEqual(f.renames, []);
  const result = await f.run('rename @**[cc-sonnet-5-5] Scout** Pathfinder', { kind: 'dm', userIds: [1] });
  assert.match(result.content, /Renamed/);
  f.prior({ suffix: 'scout', personaName: '[cc-opus-5-5] Scout', tmuxSession: 'cc-another', botUserId: 43 });
  const count = f.renames.length;
  assert.equal((await f.run('rename scout Guide')).content, 'Ambiguous hand name — use its bot email or tmux session; nothing was changed.');
  assert.equal(f.renames.length, count);
  assert.match((await f.run('rename cc-scout Guide')).content, /Name collision/);
});

for (const alias of ['Pathfinder', 'scout']) test(`renamed rehome/model revival via ${alias} does not bypass ownership`, async () => {
  const f = fixture(); f.prior(); await f.run('rename scout Pathfinder');
  assert.match((await f.run(`spawn opus-5-5 name=${alias}`, elsewhere, 2)).content, /Only this hand's creator/);
  assert.equal(f.launches.length, 0); assert.deepEqual(f.subscriptions, []);
});

// Reviewer M1 probes: a rename must not change which existing identity a spawn selects.
test('rename rejects tmux/suffix overlap; cc-scout still revives its exact hand', async () => {
  const f = fixture(); const a = f.prior();
  const c = f.prior({ suffix: 'cc-scout', personaName: '[cc-sonnet-5-5] cc-scout', tmuxSession: 'cc-cc-scout',
    botUserId: 43, botEmail: 'cc-cc-scout-bot@x', sessionId: 'cccccccc-1234-1234-1234-123456789abc', spawnedBy: { userId: 2, username: 'C' } });
  const before = structuredClone(a);
  assert.match((await f.run('rename cc-scout Guide', home, 9)).content, /Ambiguous/);
  assert.match((await f.run(`rename ${a.botEmail} Guide`, home, 9)).content, /Name collision/);
  assert.deepEqual(a, before); assert.deepEqual(f.renames, []);
  assert.match((await f.run('spawn sonnet-5-5 name=cc-scout', home, 2)).content, /Revived/);
  assert.equal(f.launches[0].tmuxSession, c.tmuxSession);
  assert.equal(f.launches[0].sessionId, c.sessionId);
});

test('rename rejects shared suffix; opus scout revival still selects the opus hand', async () => {
  const f = fixture(); const a = f.prior();
  const b = f.prior({ personaName: '[cc-opus-5-5] Scout', model: 'claude-opus-5-5', tmuxSession: 'cc-opus-scout',
    botUserId: 43, botEmail: 'opus-scout-bot@x', sessionId: 'bbbbbbbb-1234-1234-1234-123456789abc', spawnedBy: { userId: 2, username: 'B' } });
  assert.match((await f.run('rename cc-scout Guide')).content, /Name collision/);
  assert.equal(a.friendlyName, undefined); assert.deepEqual(f.renames, []);
  assert.match((await f.run('spawn opus-5-5 name=scout', home, 2)).content, /Revived/);
  assert.equal(f.launches[0].tmuxSession, b.tmuxSession);
  assert.equal(f.launches[0].sessionId, b.sessionId);
});

// Imported registries may already contain collisions written by the previous release.
// These tests kill an alias-first selection mutation even though new renames reject them.
for (const selection of ['exact', 'legacy', 'history'] as const) test(`${selection} spawn selection wins over a conflicting renamed alias (M5)`, async () => {
  const f = fixture();
  f.prior({ suffix: 'other', personaName: '[cc-sonnet-5-5/h] Guide', tmuxSession: 'cc-other', friendlyName: 'Guide', nameAliases: ['scout'],
    botEmail: 'other-bot@x', spawnedBy: { userId: 1, username: 'A' } });
  const b = f.prior({ personaName: selection === 'legacy' ? 'Claude-Code-opus-5-5-scout' : `[cc-${selection === 'exact' ? 'opus-5-5' : 'haiku-4-5'}] Scout`,
    nameScheme: selection === 'legacy' ? undefined : 'bracket-v1', model: selection === 'history' ? 'claude-haiku-4-5' : 'claude-opus-5-5',
    tmuxSession: 'cc-b-scout', botUserId: 43, botEmail: 'b-bot@x', sessionId: 'bbbbbbbb-1234-1234-1234-123456789abc', spawnedBy: { userId: 2, username: 'B' } });
  assert.match((await f.run('spawn opus-5-5 name=scout', home, 2)).content, /Revived/);
  assert.equal(f.launches[0].tmuxSession, b.tmuxSession);
  assert.equal(f.launches[0].sessionId, b.sessionId);
});

test('legacy Claude-Code exact revival wins over another model with the same suffix (M4)', async () => {
  const f = fixture();
  const legacy = f.prior({ personaName: 'Claude-Code-sonnet-5-5-scout', nameScheme: undefined, tmuxSession: 'cc-sonnet-5-5-scout' });
  f.prior({ personaName: '[cc-opus-5-5] Scout', model: 'claude-opus-5-5', tmuxSession: 'cc-opus-scout', botUserId: 43, botEmail: 'opus-bot@x',
    sessionId: 'bbbbbbbb-1234-1234-1234-123456789abc', spawnedBy: { userId: 2, username: 'B' } });
  assert.match((await f.run('spawn sonnet-5-5 name=scout')).content, /Revived/);
  assert.equal(f.launches[0].tmuxSession, legacy.tmuxSession);
  assert.equal(f.launches[0].sessionId, legacy.sessionId);
  assert.deepEqual(f.renames, []);
  assert.equal(f.registry.alive()[0].personaName, legacy.personaName);
});

for (const patch of [
  { suffix: 'cc-scout' }, { tmuxSession: 'scout' }, { personaName: '[cc-opus-5-5] cc-scout' },
  { friendlyName: 'cc-scout' }, { nameAliases: ['cc-scout'] },
] as Partial<BotEntry>[]) test(`rename checks all resulting names against another hand: ${JSON.stringify(patch)}`, async () => {
  const f = fixture(); const a = f.prior(); const before = structuredClone(a);
  f.prior({ suffix: 'other', personaName: '[cc-opus-5-5] Other', tmuxSession: 'cc-other', botUserId: 43, botEmail: 'other-bot@x', ...patch });
  assert.match((await f.run(`rename ${a.botEmail} Guide`)).content, /Name collision/);
  assert.deepEqual(a, before); assert.deepEqual(f.renames, []);
});

test('a resulting old alias is also checked for collisions', async () => {
  const f = fixture(); const a = f.prior({ friendlyName: 'Scout', nameAliases: ['Reserved'] });
  f.prior({ suffix: 'reserved', personaName: '[cc-opus-5-5] Other', tmuxSession: 'cc-other', botUserId: 43, botEmail: 'other-bot@x' });
  assert.match((await f.run(`rename ${a.botEmail} Guide`)).content, /Name collision/);
  assert.deepEqual(f.renames, []);
});

for (const prefix of ['@**', '@_**']) for (const id of [42, 43]) test(`stop ${prefix}name|${id}** keeps upstream mention handling and cannot stop another ID (M2)`, async () => {
  const f = live();
  const other = f.prior({ suffix: 'other', personaName: '[cc-opus-5-5] Other', tmuxSession: 'cc-other', botUserId: 43, status: 'alive' });
  assert.match((await f.run(`stop ${prefix}${f.e.personaName}|${id}**`)).content, /No running hand matches/);
  assert.equal(f.e.status, 'alive'); assert.equal(other.status, 'alive'); assert.equal(f.state.running, true);
});

test('unknown stored effort produces an effort error, not an invalid-name error', async () => {
  const f = fixture(); const e = f.prior({ effort: 'future-effort' }); const before = structuredClone(e);
  const result = await f.run('rename scout Guide');
  assert.match(result.content, /Stored effort `future-effort` is not recognized/);
  assert.doesNotMatch(result.content, /Invalid hand name/);
  assert.deepEqual(e, before); assert.deepEqual(f.renames, []);
});

for (const creatorOnlyControls of [undefined, false, true]) for (const ownerUserId of [undefined, null, 10]) {
  test(`legacy controls: creatorOnlyControls=${creatorOnlyControls}, owner=${ownerUserId}`, async () => {
    const f = fixture({ creatorOnlyControls, ownerUserId });
    const e = f.prior({ status: 'alive' }); f.state.running = true;
    const restricted = creatorOnlyControls === true;
    assert.match((await f.run('press scout esc', home, 2)).content, restricted ? /Only this hand's creator/ : /Sent/);
    f.state.escaped = false; f.state.capture = 0; f.state.panes = [PERMISSION_AFTER_MODEL];
    await f.run('rescan');
    const count = f.keys.length;
    assert.match((await f.run('answer scout 1', home, 2)).content, restricted ? /Only this hand's creator/ : /Answer sent/);
    assert.equal(f.keys.length - count, restricted ? 0 : 1);
    await f.run('stop scout');
    assert.match((await f.run('spawn sonnet-5-5 name=scout', elsewhere, 2)).content, restricted ? /Only this hand's creator/ : /Revived/);
    assert.equal(f.registry.all().at(-1)!.spawnedBy?.userId, 1);
    // Rename/model now follow the same policy as the legacy controls.
    assert.match((await f.run(`rename ${e.botEmail} Guide`, home, 2)).content, restricted ? /Only this hand's creator/ : /Renamed/);
    await f.run('stop scout');
    assert.match((await f.run('spawn opus-5-5 name=scout', home, 2)).content, restricted ? /Only this hand's creator/ : /Revived/);
  });
}

for (const ownerUserId of [undefined, null]) test(`no implicit owner 9 when ownerUserId=${ownerUserId}`, async () => {
  const f = fixture({ ownerUserId, creatorOnlyControls: true }); const e = f.prior({ status: 'alive' }); f.state.running = true;
  assert.match((await f.run('press scout esc', home, 9)).content, /owner \(not configured\)/);
  assert.match((await f.run('rename scout Guide', home, 9)).content, /owner \(not configured\)/);
  assert.match((await f.run('model scout opus-5-5', home, 9)).content, /owner \(not configured\)/);
  assert.deepEqual(f.keys, []); assert.deepEqual(f.texts, []); assert.deepEqual(f.renames, []);
  assert.equal(e.personaName, '[cc-sonnet-5-5] Scout');
});

for (const ownerUserId of [undefined, null]) test(`adopted hand with no creator/owner retains legacy controls even in strict mode (${ownerUserId})`, async () => {
  const f = fixture({ ownerUserId, creatorOnlyControls: true });
  f.prior({ status: 'alive', spawnedBy: undefined }); f.state.running = true;
  assert.match((await f.run('press scout esc', home, 2)).content, /Sent/);
  f.state.escaped = false; f.state.capture = 0; f.state.panes = [PERMISSION_AFTER_MODEL];
  await f.run('rescan');
  assert.match((await f.run('answer scout 1', home, 2)).content, /Answer sent/);
  await f.run('stop scout');
  assert.match((await f.run('spawn sonnet-5-5 name=scout', elsewhere, 2)).content, /Revived/);
  assert.equal(f.registry.alive()[0].spawnedBy, undefined);
  assert.match((await f.run('rename scout Guide', home, 2)).content, /Renamed/);
  f.state.escaped = false; f.state.capture = 0; f.state.panes = ['? for shortcuts', CLAUDE_CONFIRM, CLAUDE_CHANGED];
  assert.match((await f.run('model scout opus-5-5', home, 2)).content, /without stopping/);
  assert.equal(f.registry.alive()[0].spawnedBy, undefined);
});

for (const personaName of ['Claude-Code-sonnet-5-5-scout', '[cc-sonnet-5-5] Scout', '[cc-sonnet-5-5/h] Scout']) {
  test(`unchanged revival keeps display name verbatim: ${personaName}`, async () => {
    const f = fixture(); const e = f.prior({ personaName, nameScheme: personaName.startsWith('[') ? 'bracket-v1' : undefined });
    assert.match((await f.run('spawn sonnet-5-5 name=scout', elsewhere)).content, /Revived/);
    assert.equal(f.registry.alive()[0].personaName, e.personaName);
    assert.deepEqual(f.renames, []);
  });
}

for (const command of ['spawn opus-5-5 name=scout', 'spawn sonnet-5-5 name=scout effort=medium', 'model scout opus-5-5']) {
  test(`${command}: model/effort display rename reserves previous full name without explicit friendly rename`, async () => {
    const f = fixture(); const e = f.prior({ status: command.startsWith('model') ? 'alive' : 'reaped' });
    const oldName = e.personaName;
    if (command.startsWith('model')) { f.state.running = true; f.state.panes = ['? for shortcuts', CLAUDE_CONFIRM, CLAUDE_CHANGED]; }
    assert.match((await f.run(command)).content, /Revived|without stopping/);
    const current = f.registry.alive()[0];
    assert.notEqual(current.personaName, oldName);
    assert.ok(current.nameAliases?.includes(oldName));
    assert.equal(f.registry.findAlive(oldName), current);
    assert.match((await f.run(`stop @**${oldName}**`)).content, /Stopped/);
    assert.match((await f.run('spawn sonnet-5-5 name=scout')).content, /Revived/);
    assert.ok(f.registry.alive()[0].nameAliases?.includes(oldName), 'aliases survive every launch');
  });
}

test('rename hints use current friendly name for stop, press and questions', async () => {
  const f = live();
  assert.match((await f.run('rename scout Guide')).content, /Renamed/);
  assert.match((await f.run('press Guide esc')).content, /peek Guide/);
  f.state.escaped = false; f.state.capture = 0; f.state.panes = [PERMISSION_AFTER_MODEL];
  await f.run('rescan');
  assert.match(f.posts.at(-1)!.content, /answer Guide 1/);
  assert.match((await f.run('rescan')).content, /answer Guide/);
  assert.match((await f.run('stop Guide')).content, /name=Guide/);
});

test('collaborative controls open model-menu answers to allowed noncreators', async () => {
  const f = live('codex'); f.config.creatorOnlyControls = false;
  f.state.panes = ['Ask Codex to do anything', CODEX_MODELS];
  assert.match((await f.run('model scout')).content, /menu posted/);
  const before = f.keys.length;
  assert.match(f.posts[0].content, /Any allowed caller: mention/);
  f.state.capture = 0; f.state.panes = ['Ask Codex to do anything', CODEX_MODELS, CODEX_REASONING, CODEX_CHANGED];
  assert.match((await f.run('answer scout 6', home, 2)).content, /without stopping/);
  assert.ok(f.keys.length > before); assert.equal(f.renames.length, 1);
  assert.equal(f.e.model, 'gpt-6.1-terra');
  assert.equal(f.e.spawnedBy?.userId, 1);
});

for (const overlap of ['session', 'alias']) test(`a running renamed hand's ${overlap} cannot block another hand's exact revival`, async t => {
  const f = fixture();
  const a = f.prior({ status: 'alive', friendlyName: 'Guide', nameAliases: overlap === 'alias' ? ['cc-scout'] : ['scout'] });
  const c = f.prior({ suffix: 'cc-scout', personaName: '[cc-sonnet-5-5] cc-scout', tmuxSession: 'cc-cc-scout',
    botUserId: 43, botEmail: 'cc-cc-scout-bot@x', sessionId: 'cccccccc-1234-1234-1234-123456789abc', spawnedBy: { userId: 2, username: 'C' } });
  const deps = (f.actions as unknown as { d: import('../src/actions.js').ActionDeps }).d;
  t.mock.method(deps.tmux, 'hasSession', async (name: string) => name === a.tmuxSession);
  assert.match((await f.run('spawn sonnet-5-5 name=cc-scout', home, 2)).content, /Revived/);
  assert.equal(f.launches[0].tmuxSession, c.tmuxSession);
  assert.equal(f.launches[0].sessionId, c.sessionId);
  assert.equal(a.status, 'alive');
});

test('Claude 2.1.323 end-to-end: full menu posted, numeric Fable snapshot reopens and verifies version', async () => {
  const f = live();
  const replay = claude323Replay(f.keys, f.texts);
  Object.assign(f.tmux, replay.tmux);
  assert.match((await f.run('model scout', elsewhere)).content, /menu posted/);
  assert.equal(f.posts[0].streamName, 'cc-hands');
  assert.equal(f.posts[0].topic, 'old');
  for (const row of ['2. Opus', '3. Fable', '4. Sonnet ✔', '5. Haiku']) assert.ok(f.posts[0].content.includes(row), row);
  assert.doesNotMatch(f.posts[0].content, /More entries/);
  assert.deepEqual(f.e.pendingModelMenu!.options.map(o => [o.number, o.model]), [
    [2, 'claude-opus-5-5'], [3, 'claude-fable-5-2'], [4, 'claude-sonnet-5-5'], [5, 'claude-haiku-5-5'],
  ]);
  assert.equal(f.e.model, 'claude-sonnet-5-5');
  assert.deepEqual(f.keys.at(-1), ['Escape']);
  assert.equal(replay.index, 8);
  assert.match((await f.run('answer scout 3')).content, /without stopping/);
  assert.equal(f.e.model, 'claude-fable-5-2');
  assert.equal(f.e.pendingModelMenu, undefined);
  assert.deepEqual(f.texts, ['/model', '/model claude-fable-5-2']);
  assert.deepEqual(f.keys.at(-1), ['1']);
  assert.equal(f.launches.length, 0);
});

test('Claude 2.1.323 end-to-end: explicit fable-5-2 matches versioned confirmation', async () => {
  const f = live();
  f.state.panes = ['? for shortcuts', CLAUDE_323_CONFIRM, CLAUDE_323_CHANGED];
  assert.match((await f.run('model scout fable-5-2')).content, /without stopping/);
  assert.equal(f.e.model, 'fable-5-2');
  assert.deepEqual(f.texts, ['/model fable-5-2']);
  assert.deepEqual(f.keys, [['Enter'], ['1']]);
});

for (const stage of ['confirm', 'success']) test(`Claude 2.1.323 end-to-end: mismatched ${stage} retains registry/name`, async () => {
  const f = live();
  const before = f.e.personaName;
  f.state.panes = ['? for shortcuts',
    stage === 'confirm' ? CLAUDE_323_CONFIRM.replace('5.2', '5.1') : CLAUDE_323_CONFIRM,
    stage === 'success' ? CLAUDE_323_CHANGED.replace('5.2', '5.1') : CLAUDE_323_CHANGED,
  ];
  assert.match((await f.run('model scout fable-5-2')).content, /Could not change/);
  assert.equal(f.e.model, 'claude-sonnet-5-5');
  assert.equal(f.e.personaName, before);
  assert.deepEqual(f.renames, []);
  assert.deepEqual(f.keys, stage === 'confirm' ? [['Enter'], ['Escape']] : [['Enter'], ['1'], ['Escape']]);
});
// Omitted flag/owner values exercise the runtime defaults as well as explicit
// false/null. Every operation gets a fresh identity so no earlier success can
// accidentally authorize a later operation or mask a model-changing revival.
for (const creatorOnlyControls of [undefined, false, true]) for (const ownerUserId of [undefined, null, 10]) {
  for (const adopted of [false, true]) for (const user of [1, 2, 10]) {
    test(`rename/model policy: strict=${creatorOnlyControls}, owner=${ownerUserId}, adopted=${adopted}, caller=${user}`, async () => {
      const config = { creatorOnlyControls, ownerUserId };
      const spawnedBy = adopted ? undefined : { userId: 1, username: 'Creator' };
      const allowed = !creatorOnlyControls || (!adopted && user === 1) || user === ownerUserId || (adopted && ownerUserId == null);
      for (const operation of ['rename', 'model', 'answer', 'shortcut', 'cancel', 'revive', 'rehome']) {
        const revival = operation === 'revive' || operation === 'rehome';
        const f = revival ? fixture(config) : live('claude', config);
        const e = revival ? f.prior({ spawnedBy }) : f.registry.alive()[0];
        f.registry.update(e, { spawnedBy });
        if (['answer', 'shortcut', 'cancel'].includes(operation)) {
          f.registry.update(e, { pendingModelMenu: {
            options: [{ number: 2, label: 'Opus 5.5', model: 'claude-opus-5-5' }],
            postedAt: new Date().toISOString(),
          } });
        }
        const before = structuredClone(f.registry.all());
        const command = operation === 'rename' ? 'rename scout Guide'
          : operation === 'model' ? 'model scout opus-5-5'
          : operation === 'answer' ? 'answer scout 2'
          : operation === 'shortcut' ? '2'
          : operation === 'cancel' ? 'answer scout esc'
          : 'spawn opus-5-5 name=scout';
        const result = await f.run(command, operation === 'rehome' ? elsewhere : home, user);
        if (!allowed) {
          assert.match(result.content, /Only this hand's creator.*creatorOnlyControls is enabled/, operation);
          assert.deepEqual(f.registry.all(), before, operation);
          assert.deepEqual(f.keys, [], operation); assert.deepEqual(f.texts, [], operation);
          assert.deepEqual(f.renames, [], operation); assert.deepEqual(f.launches, [], operation);
          assert.deepEqual(f.subscriptions, [], operation);
        } else {
          assert.match(result.content, operation === 'rename' ? /Renamed/ : operation === 'cancel' ? /cancelled/ : revival ? /Revived/ : /without stopping/, operation);
          const current = f.registry.alive()[0];
          if (!['rename', 'cancel'].includes(operation)) assert.equal(current.model, 'claude-opus-5-5', operation);
          if (operation === 'rehome') assert.equal(current.streamId, elsewhere.streamId);
          if (operation === 'cancel') assert.equal(current.pendingModelMenu, undefined);
          assert.deepEqual(current.spawnedBy, spawnedBy, operation);
          const persisted = new Registry(join(f.dir, 'registry.json')); persisted.load();
          assert.deepEqual(persisted.alive()[0].spawnedBy, spawnedBy, operation);
          if (adopted) assert.ok(f.registry.all().every(entry => entry.spawnedBy === undefined), operation);
        }
      }
    });
  }
}

for (const creatorOnlyControls of [false, true]) for (const denial of ['user', 'stream', 'owner']) {
  test(`rename/model cannot bypass ${denial} allow-list (strict=${creatorOnlyControls})`, async () => {
    const f = live('claude', { creatorOnlyControls, ownerUserId: 10, allowedStreams: ['cc-hands'] });
    f.e.pendingModelMenu = { options: [{ number: 2, label: 'Opus 5.5', model: 'claude-opus-5-5' }], postedAt: '2000-01-01T00:00:00Z' };
    const user = denial === 'owner' ? 10 : denial === 'user' ? 99 : 1;
    if (denial === 'owner') f.config.allowedUsers = [1, 2];
    const where = denial === 'stream' ? elsewhere : home;
    const before = structuredClone(f.registry.all());
    for (const command of ['rename scout Guide', 'model scout opus-5-5', 'answer scout 2', '2', 'spawn opus-5-5 name=scout']) {
      assert.match((await f.run(command, where, user)).content, /Not authorized:.*allow-listed/);
      assert.deepEqual(f.registry.all(), before);
      assert.deepEqual(f.keys, []); assert.deepEqual(f.texts, []); assert.deepEqual(f.renames, []);
      assert.deepEqual(f.launches, []); assert.deepEqual(f.subscriptions, []);
    }
  });
}
