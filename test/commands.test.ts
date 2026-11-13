import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelSlug, parseCommand, resolveModel, stripMentions, effortError, modelCapability, modelsListing, MODEL_ALIASES, USAGE } from '../src/commands.js';
import { startsWithMention } from '../src/control.js';

test('spawn resolves explicit model aliases and options', () => {
  assert.deepEqual(parseCommand('spawn opus-5-5 name=scout effort=high'), {
    kind: 'spawn',
    model: 'claude-opus-5-5',
    friendly: 'scout',
    effort: 'high',
  });
  assert.equal(resolveModel('opus55'), 'claude-opus-5-5');
  assert.equal(resolveModel('Sonnet5.5'), 'claude-sonnet-5-5');
});

test('spawn refuses bare families, bad names and unknown options', () => {
  assert.equal(parseCommand('spawn opus').kind, 'help');
  assert.match((parseCommand('spawn opus') as { error: string }).error, /refused/);
  assert.match((parseCommand('spawn opus-5-5 name=bad_name') as { error: string }).error, /bad name/);
  assert.match((parseCommand('spawn opus-5-5 color=red') as { error: string }).error, /unknown option/);
});

test('effort is validated per model', () => {
  assert.match((parseCommand('spawn haiku-4-5 effort=high') as { error: string }).error, /no effort setting/);
  assert.match((parseCommand('spawn opus-4-6 effort=ultracode') as { error: string }).error, /not available/);
  assert.equal(parseCommand('spawn opus-5-5 effort=ultracode').kind, 'spawn');
  assert.equal(parseCommand('spawn opus-5-5 effort=default').kind, 'spawn');
});

test('fixed-arity commands reject trailing text', () => {
  assert.deepEqual(parseCommand('stop scout'), { kind: 'stop', target: 'scout' });
  assert.deepEqual(parseCommand('kill scout'), { kind: 'stop', target: 'scout' });
  assert.equal(parseCommand('stop scout and then deploy').kind, 'help');
  assert.equal(parseCommand('list everything').kind, 'help');
  assert.deepEqual(parseCommand('peek scout 50'), { kind: 'peek', target: 'scout', lines: 50 });
});

test('answer keeps free text intact', () => {
  assert.deepEqual(parseCommand('answer scout text: use  the  blue one'), {
    kind: 'answer',
    target: 'scout',
    spec: 'text: use  the  blue one',
  });
});

test('unknown verbs are marked for the answer shortcut', () => {
  const c = parseCommand('2');
  assert.equal(c.kind, 'help');
  assert.equal((c as { unknownVerb?: boolean }).unknownVerb, true);
});

test('stripMentions removes leading Zulip mentions only', () => {
  assert.equal(stripMentions('@**CC Spawner** list'), 'list');
  assert.equal(stripMentions('@**CC Spawner|42**, stop scout'), 'stop scout');
  assert.equal(stripMentions('@_**Tester** @**CC Spawner** list'), 'list');
  assert.equal(stripMentions('list @**CC Spawner**'), 'list @**CC Spawner**');
});

test('a stream command must start with the spawner mention', () => {
  assert.ok(startsWithMention('@**CC Spawner** list', 'CC Spawner', 42));
  assert.ok(startsWithMention('@**cc spawner|42** list', 'CC Spawner', 42));
  assert.ok(!startsWithMention('    @**CC Spawner** list', 'CC Spawner', 42), 'indented = code block');
  assert.ok(startsWithMention('@**Renamed|42** list', 'CC Spawner', 42));
  assert.ok(!startsWithMention('please @**CC Spawner** stop scout', 'CC Spawner', 42));
  assert.ok(!startsWithMention('@_**CC Spawner** list', 'CC Spawner', 42), 'silent mentions do not count');
  assert.ok(!startsWithMention('```quote\n@**CC Spawner** stop scout\n```', 'CC Spawner', 42));
  assert.ok(!startsWithMention('@**CC Spawner Two** list', 'CC Spawner', 42));
});

test('modelSlug keeps names short and stable', () => {
  assert.equal(modelSlug('claude-opus-5-5'), 'opus-5-5');
  assert.equal(modelSlug('global.anthropic.claude-sonnet-4-5-20250929'), 'sonnet-4-5');
});

test('models and help models parse with fixed arity; help documents Codex', () => {
  for (const text of ['models', 'help models', 'HELP MODELS']) assert.deepEqual(parseCommand(text), { kind: 'models' });
  for (const text of ['models extra', 'help models extra']) assert.equal(parseCommand(text).kind, 'help');
  for (const text of ['gpt-*', 'engine=codex|claude', '[cx-<model>] <name>', 'Codex efforts:', 'minimal', 'xhigh', 'max', 'ultra', 'models']) assert.ok(USAGE.includes(text), text);
});

const capabilityCases: [string, string[]][] = [
  ...['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6.1-sol', 'gpt-unknown', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini'].map((m): [string, string[]] => [m, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']]),
  ...['claude-3-opus', 'claude-haiku-4-5', 'claude-sonnet-4-5'].map((m): [string, string[]] => [m, []]),
  ['claude-opus-4-5', ['low', 'medium', 'high']],
  ['claude-opus-4-6', ['low', 'medium', 'high', 'max']],
  ['claude-sonnet-4-6', ['low', 'medium', 'high', 'max']],
  ['claude-opus-4-7', ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']],
  ['claude-opus-5-5', ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']],
];
for (const [model, allowed] of capabilityCases) {
  test(`capabilities, validation and listing agree: ${model}`, () => {
    const row = modelCapability(model);
    assert.deepEqual(row.efforts, allowed);
    assert.ok(modelsListing().includes(`${row.label} — ${row.engine}: ${[...allowed, 'default'].join(', ')}`));
    for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode', 'bogus', 'default']) {
      const valid = allowed.includes(effort) || effort === 'default';
      assert.equal(effortError(effort, model) === undefined, valid, effort);
      assert.equal(parseCommand(`spawn ${model} effort=${effort}`).kind, valid ? 'spawn' : 'help');
    }
  });
}

test('listing resolves every alias and explains defaults; overrides select the engine', () => {
  for (const [alias, id] of Object.entries(MODEL_ALIASES)) {
    const row = modelCapability(id);
    assert.ok(modelsListing().includes(`\`${alias}\` → \`${id}\` — ${row.engine}: ${[...row.efforts, 'default'].join(', ')}`));
  }
  assert.match(modelsListing(), /no default model/);
  assert.match(modelsListing(), /no override/);
  assert.equal(effortError('max', 'GPT-6-ASTRA'), undefined);
  assert.equal(effortError('ultra', 'other', 'codex'), undefined);
  assert.match(modelsListing(), /passed to codex \(model-dependent\)/);
  assert.equal(effortError('max', 'gpt-5.5'), undefined);
  assert.match(effortError('bogus', 'other', 'codex')!, /`bogus` is not available on `other`/);
  assert.equal(effortError('ultracode', 'gpt-6-astra', 'claude'), undefined);
  assert.ok(effortError('ultracode', 'gpt-6-astra', 'codex'));
});

for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-6.1-sol', 'gpt-new', 'provider/custom']) {
  test(`Codex model preserves every effort: ${model}`, () => {
    for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      const cmd = parseCommand(`spawn ${model} effort=${effort} engine=codex`);
      assert.equal(cmd.kind, 'spawn');
      if (cmd.kind === 'spawn') {
        assert.equal(cmd.model, model);
        assert.equal(cmd.effort, effort);
        assert.equal(cmd.engine, 'codex');
      }
    }
  });
}

test('Codex upstream ceilings are advisory, never validation limits', () => {
  for (const [model, ceiling] of [
    ['gpt-6-astra', 'ultra'], ['gpt-5.6-sol', 'ultra'], ['gpt-5.6-terra', 'ultra'],
    ['gpt-5.6-luna', 'max'], ['gpt-5.5', 'xhigh'], ['gpt-5.4-mini', 'xhigh'],
  ]) {
    const row = modelCapability(model);
    assert.equal(row.upstreamMax, ceiling);
    const line = modelsListing().split('\n').find(line => line.startsWith(`* ${model} —`))!;
    assert.ok(line.includes(`advisory: up to ${ceiling} (upstream data; higher passed through, codex decides)`));
    for (const effort of ['bogus', 'ultracode', "high';echo-PWN", '$(id)', 'high;id', 'high"']) {
      assert.ok(effortError(effort, model)!.includes(`on \`${model}\``));
      assert.equal(parseCommand(`spawn ${model} effort=${effort}`).kind, 'help');
    }
  }
});

test('rename grammar accepts friendly/full/mention targets and strictly rejects malformed commands', () => {
  for (const target of ['scout', '[cc-opus-5-5/h] Scout', '@**[cc-opus-5-5/h] Scout|42**']) {
    assert.deepEqual(parseCommand(`rename ${target} Pathfinder`), { kind: 'rename', target, friendly: 'Pathfinder' });
  }
  for (const text of ['rename', 'rename scout', 'rename scout Guide extra', 'rename scout bad_name', 'rename scout bad!', `rename scout ${'x'.repeat(25)}`]) {
    assert.equal(parseCommand(text).kind, 'help', text);
  }
});
