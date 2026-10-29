import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelSlug, parseCommand, resolveModel, stripMentions } from '../src/commands.js';
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
