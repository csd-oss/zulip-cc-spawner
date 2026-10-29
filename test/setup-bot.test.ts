import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setupSpawnerBot } from '../src/setup-bot.js';
import { parseZuliprc, ZulipClient, type Fetch, type ZulipCreds } from '../src/zulip.js';
import { tmp } from './helpers.js';

const owner: ZulipCreds = { email: 'owner@example.org', key: 'OWNERKEY', site: 'https://chat.example.org' };

/** A tiny Zulip: one owner, the bots it creates, streams that exist. */
function realm() {
  const bots: { username: string; full_name: string; api_key: string; user_id: number }[] = [];
  const subs: [string, number][] = [];
  let creates = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/api/v1', '');
    const who = Buffer.from(String((init?.headers as Record<string, string>).Authorization).slice(6), 'base64').toString().split(':')[0];
    const body = new URLSearchParams(init?.body ? String(init.body) : '');
    const ok = (o: object) => new Response(JSON.stringify({ result: 'success', ...o }), { status: 200 });
    const err = (msg: string) => new Response(JSON.stringify({ result: 'error', msg }), { status: 400 });
    const key = `${init?.method ?? 'GET'} ${path}`;
    if (key === 'GET /users/me') {
      if (who === owner.email) return ok({ user_id: 1, full_name: 'Owner', email: who, is_bot: false, role: 400 });
      const b = bots.find((x) => x.username === who);
      return b ? ok({ user_id: b.user_id, full_name: b.full_name, email: who, is_bot: true, role: 400 }) : err('bad key');
    }
    if (key === 'GET /bots') return ok({ bots });
    if (key === 'POST /bots') {
      creates++;
      const b = { username: `${body.get('short_name')}-bot@chat.example.org`, full_name: body.get('full_name')!, api_key: 'BOTKEY', user_id: 50 + creates };
      bots.push(b);
      return ok({ user_id: b.user_id, api_key: b.api_key });
    }
    if (path.startsWith('/users/') && key.startsWith('GET')) {
      const b = bots.find((x) => x.username === decodeURIComponent(path.slice(7)));
      return b ? ok({ user: { user_id: b.user_id } }) : err('no such user');
    }
    if (key === 'GET /get_stream_id') return url.searchParams.get('stream') === 'ops' ? ok({ stream_id: 3 }) : err('Invalid channel name');
    if (key === 'POST /users/me/subscriptions') {
      for (const p of JSON.parse(body.get('principals')!)) subs.push([JSON.parse(body.get('subscriptions')!)[0].name, p]);
      return ok({ subscribed: {}, already_subscribed: {} });
    }
    return err(`no route ${key}`);
  }) as Fetch;
  return { bots, subs, creates: () => creates, client: (c: ZulipCreds) => new ZulipClient(c, fetchImpl) };
}

test('setup-bot creates the bot once, subscribes it, writes a 0600 zuliprc', async () => {
  const z = realm();
  const out = join(tmp(), 'spawner.zuliprc');
  const opts = { owner, out, name: 'CC Spawner', short: 'cc-spawner', subscribe: ['ops'] };
  const first = await setupSpawnerBot(opts, z.client);
  assert.deepEqual(first, { userId: 51, email: 'cc-spawner-bot@chat.example.org', created: true, written: true, subscribed: ['ops'] });
  assert.deepEqual(parseZuliprc(readFileSync(out, 'utf8')), { email: 'cc-spawner-bot@chat.example.org', key: 'BOTKEY', site: owner.site });
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.deepEqual(z.subs, [['ops', 51]]);

  const again = await setupSpawnerBot(opts, z.client);
  assert.equal(again.created, false);
  assert.equal(again.written, false);
  assert.equal(z.creates(), 1, 'rerun reuses the bot');
});

test('setup-bot refuses a bot as owner and a stream that does not exist', async () => {
  const z = realm();
  const out = join(tmp(), 'spawner.zuliprc');
  await setupSpawnerBot({ owner, out, name: 'CC Spawner', short: 'cc-spawner', subscribe: [] }, z.client);
  const botAsOwner = { email: 'cc-spawner-bot@chat.example.org', key: 'BOTKEY', site: owner.site };
  await assert.rejects(setupSpawnerBot({ owner: botAsOwner, out, name: 'x', short: 'x', subscribe: [] }, z.client), /is a bot/);
  await assert.rejects(setupSpawnerBot({ owner, out, name: 'CC Spawner', short: 'cc-spawner', subscribe: ['nope'] }, z.client), /Invalid channel/);
  assert.deepEqual(z.subs, [], 'nothing subscribed (Zulip would have created the stream)');
});
