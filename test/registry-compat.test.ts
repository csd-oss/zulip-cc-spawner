import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { Registry, type BotEntry } from '../src/registry.js';
import { tmp } from './helpers.js';

// Synthetic offline entries using only fields supported by the named revisions.
// The actual historical reader below is verbatim `git show b4bc984f:src/registry.ts`.
for (const revision of ['b4bc984f', '0e76875']) test(`${revision} registry loads and round-trips without migration or dropped fields`, () => {
  const source = readFileSync(new URL(`./fixtures/registry-${revision}.json`, import.meta.url), 'utf8');
  const path = join(tmp(), 'registry.json');
  writeFileSync(path, source);
  const registry = new Registry(path);
  registry.load();
  assert.equal(readFileSync(path, 'utf8'), source, 'load never writes');
  assert.deepEqual(registry.all(), JSON.parse(source));
  const e = registry.all()[0];
  assert.equal(registry.latestFor(e.personaName), e);
  assert.equal(e.friendlyName, undefined); assert.equal(e.nameAliases, undefined);
  registry.save();
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), JSON.parse(source));
  if (revision === '0e76875') assert.equal(e.spawnedBy, undefined, 'unknown authorship stays absent');
});

for (const revision of ['b4bc984f', '0e76875']) test(`actual b4bc984f reader preserves new optional rename metadata on ${revision} format`, async () => {
  const source = readFileSync(new URL('./fixtures/registry-b4bc984f.ts.txt', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { Registry: HistoricalRegistry } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  const path = join(tmp(), 'registry.json');
  writeFileSync(path, readFileSync(new URL(`./fixtures/registry-${revision}.json`, import.meta.url)));
  const registry = new Registry(path); registry.load();
  const entry = registry.all()[0];
  registry.update(entry, { personaName: '[cc-sonnet-5-5/h] Pathfinder', friendlyName: 'Pathfinder', nameAliases: ['Scout', '[cc-sonnet-5-5] Scout'] });
  const expected = JSON.parse(readFileSync(path, 'utf8'));
  const historical = new HistoricalRegistry(path); historical.load();
  assert.deepEqual(historical.all(), expected);
  assert.equal(historical.latestFor(entry.personaName).sessionId, entry.sessionId);
  historical.update(historical.all()[0], { status: 'alive' });
  assert.equal(historical.findAlive('scout').botEmail, entry.botEmail, 'original suffix still usable by old commands');
  assert.equal(historical.findAlive(entry.personaName).tmuxSession, entry.tmuxSession);
  const reloaded = new Registry(path); reloaded.load();
  assert.equal(reloaded.findAlive('Pathfinder')?.sessionId, entry.sessionId);
  assert.deepEqual(reloaded.all()[0].nameAliases, entry.nameAliases, 'old save retains unknown fields');
  assert.deepEqual(reloaded.all().slice(1), expected.slice(1), 'unrelated old entries untouched');
});

test('lookup aliases belong only to the renamed stable identity, across launch history', () => {
  const path = join(tmp(), 'registry.json');
  const entries: BotEntry[] = JSON.parse(readFileSync(new URL('./fixtures/registry-b4bc984f.json', import.meta.url), 'utf8'));
  const registry = new Registry(path);
  registry.add(entries[0]);
  const history = structuredClone(entries[0]);
  const current = { ...entries[0], personaName: '[cc-opus-5-5/h] Pathfinder', friendlyName: 'Pathfinder',
    nameAliases: ['Scout', entries[0].personaName], status: 'alive' as const };
  registry.add(current);
  const other = { ...entries[1], status: 'alive' as const }; registry.add(other);
  for (const target of ['scout', 'Pathfinder', entries[0].personaName, current.personaName, '@**[cc-opus-5-5/h] Pathfinder**', current.botEmail, current.tmuxSession]) {
    assert.equal(registry.findAlive(target), current, target);
    if (!target.startsWith('@') && target !== current.botEmail && target !== current.tmuxSession && target !== current.personaName) assert.equal(registry.renamedHands(target)[0], current, target);
  }
  assert.equal(registry.findAlive('legacy'), other);
  assert.equal(registry.findAlive('[cc-opus-5-5/h] Scout'), undefined, 'aliases are exact names, not a global substitution');
  assert.deepEqual(registry.all()[0], history, 'history is never rewritten');
});

test('spawn renamed fallback matches only the hand’s own friendly name and aliases', () => {
  const registry = new Registry(join(tmp(), 'registry.json'));
  const [entry]: BotEntry[] = JSON.parse(readFileSync(new URL('./fixtures/registry-b4bc984f.json', import.meta.url), 'utf8'));
  const current = { ...entry, friendlyName: 'Guide', nameAliases: ['OldFriendly', '[cc-opus-5-5/h] OldFriendly'] };
  registry.add(current);
  for (const target of [current.suffix, current.tmuxSession, current.botEmail, current.personaName]) {
    assert.deepEqual(registry.renamedHands(target), [], target);
  }
  for (const target of ['guide', 'OLDFRIENDLY', '[cc-opus-5-5/d] OldFriendly']) {
    assert.deepEqual(registry.renamedHands(target), [current], target);
  }
});

test('unrenamed command targets retain 0e768759 mention forms', () => {
  const registry = new Registry(join(tmp(), 'registry.json'));
  const [entry]: BotEntry[] = JSON.parse(readFileSync(new URL('./fixtures/registry-b4bc984f.json', import.meta.url), 'utf8'));
  const current = { ...entry, status: 'alive' as const }; registry.add(current);
  for (const target of [current.suffix, current.botEmail, current.tmuxSession, current.personaName, `@**${current.personaName}**`]) {
    assert.equal(registry.findAlive(target), current, target);
  }
  for (const target of [`@_**${current.personaName}**`, `@**${current.personaName}|${current.botUserId}**`, `@**${current.personaName}|999**`]) {
    assert.equal(registry.findAlive(target), undefined, target);
  }
});

test('spawn busy guard uses suffix/own names only and cannot override selected exact identity with an alias', () => {
  const registry = new Registry(join(tmp(), 'registry.json'));
  const [entry]: BotEntry[] = JSON.parse(readFileSync(new URL('./fixtures/registry-b4bc984f.json', import.meta.url), 'utf8'));
  const current = { ...entry, status: 'alive' as const, friendlyName: 'Guide', nameAliases: ['OldFriendly'] };
  registry.add(current);
  for (const target of [current.tmuxSession, current.botEmail, current.personaName]) assert.equal(registry.busy(target), undefined, target);
  for (const target of [current.suffix, 'guide', 'oldfriendly']) assert.equal(registry.busy(target), current, target);
  assert.equal(registry.busy('OldFriendly', 'another-selected-session'), undefined);
  assert.equal(registry.busy(current.suffix, 'another-selected-session'), current, 'legacy suffix guard unchanged');
});
