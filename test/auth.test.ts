import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAllowed, type AuthConfig, type Where } from '../src/auth.js';

const cfg: AuthConfig = { allowedStreams: ['cc-hands'], allowedUsers: [1], allowedGroups: [23], allowedResidents: [500] };
const inStream: Where = { kind: 'stream', streamName: 'CC-Hands', streamId: 9, topic: 't' };
const never = async () => false;

test('stream gate comes first and is case-insensitive', async () => {
  assert.equal((await isAllowed({ userId: 1, name: 'a', kind: 'user' }, inStream, cfg, never)).ok, true);
  const other: Where = { kind: 'stream', streamName: 'general', streamId: 1, topic: 't' };
  const r = await isAllowed({ userId: 1, name: 'a', kind: 'user' }, other, cfg, never);
  assert.equal(r.ok, false);
  assert.match(r.reason!, /not allow-listed/);
});

test('group membership grants access; lookup failure denies', async () => {
  assert.equal((await isAllowed({ userId: 7, name: 'b', kind: 'user' }, inStream, cfg, async () => true)).ok, true);
  assert.equal((await isAllowed({ userId: 7, name: 'b', kind: 'user' }, inStream, cfg, never)).ok, false);
  const r = await isAllowed({ userId: 7, name: 'b', kind: 'user' }, inStream, cfg, async () => {
    throw new Error('boom');
  });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /could not verify/);
});

test('bots only through allowedResidents; DMs skip the stream gate', async () => {
  const dm: Where = { kind: 'dm', userIds: [500] };
  assert.equal((await isAllowed({ userId: 500, name: 'helper-bot', kind: 'resident' }, dm, cfg, never)).ok, true);
  assert.equal((await isAllowed({ userId: 501, name: 'x', kind: 'resident' }, dm, cfg, async () => true)).ok, false);
});

test('empty allow-lists deny everyone', async () => {
  const empty: AuthConfig = { allowedStreams: ['cc-hands'], allowedUsers: [], allowedGroups: [], allowedResidents: [] };
  assert.equal((await isAllowed({ userId: 1, name: 'a', kind: 'user' }, inStream, empty, async () => true)).ok, false);
});

test('"*" allows any stream the spawner hears; users are still checked', async () => {
  const any: AuthConfig = { ...cfg, allowedStreams: ['*'] };
  const general: Where = { kind: 'stream', streamName: 'general', streamId: 1, topic: 't' };
  assert.equal((await isAllowed({ userId: 1, name: 'a', kind: 'user' }, general, any, never)).ok, true);
  assert.equal((await isAllowed({ userId: 2, name: 'b', kind: 'user' }, general, any, never)).ok, false);
});
