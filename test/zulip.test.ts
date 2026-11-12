import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Provisioner } from '../src/provision.js';
import { encodeParams, parseZuliprc, ZulipApiError, ZulipClient, type Fetch } from '../src/zulip.js';

test('zuliprc parsing', () => {
  const c = parseZuliprc('[api]\nemail=bot@example.org\nkey=abc\nsite=https://example.org/\n');
  assert.deepEqual(c, { email: 'bot@example.org', key: 'abc', site: 'https://example.org' });
  assert.throws(() => parseZuliprc('[api]\nemail=a\n'));
});

test('params: arrays/objects as JSON, booleans as strings', () => {
  const p = encodeParams({ to: [1, 2], flag: false, n: 3, s: 'x', skip: undefined });
  assert.equal(p.get('to'), '[1,2]');
  assert.equal(p.get('flag'), 'false');
  assert.equal(p.get('n'), '3');
  assert.equal(p.has('skip'), false);
});

/** A fake Zulip: route table keyed by "METHOD /path". */
function fakeZulip(routes: Record<string, (body: URLSearchParams, url: URL) => unknown>): { fetch: Fetch; calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const key = `${method} ${url.pathname.replace('/api/v1', '')}`;
    calls.push(key);
    const handler = routes[key];
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : '');
    const json = handler ? handler(body, url) : { result: 'error', msg: `no route ${key}`, code: 'BAD_REQUEST' };
    return new Response(JSON.stringify(json), { status: (json as { result: string }).result === 'success' ? 200 : 400 });
  }) as Fetch;
  return { fetch: f, calls };
}

const creds = { email: 'me@example.org', key: 'k', site: 'https://example.org' };

test('API errors carry their code', async () => {
  const { fetch } = fakeZulip({ 'GET /events': () => ({ result: 'error', msg: 'Bad event queue id', code: 'BAD_EVENT_QUEUE_ID' }) });
  const c = new ZulipClient(creds, fetch);
  await assert.rejects(c.events('q', 1), (e: unknown) => e instanceof ZulipApiError && e.code === 'BAD_EVENT_QUEUE_ID');
});

test('provisioner reuses an owned bot, else creates one', async () => {
  const bots: { username: string; full_name: string; api_key: string }[] = [
    { username: 'cc-opus-5-5-old-bot@example.org', full_name: 'Claude-Code-opus-5-5-old', api_key: 'K1' },
  ];
  const { fetch, calls } = fakeZulip({
    'GET /bots': () => ({ result: 'success', bots }),
    'GET /users/cc-opus-5-5-old-bot%40example.org': () => ({ result: 'success', user: { user_id: 11 } }),
    'GET /users/cc-opus-5-5-new-bot%40example.org': () => ({ result: 'success', user: { user_id: 12 } }),
    'POST /bots': (b) => {
      bots.push({ username: `${b.get('short_name')}-bot@example.org`, full_name: b.get('full_name')!, api_key: 'K2' });
      return { result: 'success', user_id: 12, api_key: 'K2' };
    },
  });
  const p = new Provisioner(new ZulipClient(creds, fetch));
  const old = await p.ensure('Claude-Code-opus-5-5-old', 'cc-opus-5-5-old');
  assert.deepEqual(old, { bot: { userId: 11, email: 'cc-opus-5-5-old-bot@example.org', apiKey: 'K1' }, created: false });
  assert.ok(!calls.includes('POST /bots'));
  const fresh = await p.ensure('Claude-Code-opus-5-5-new', 'cc-opus-5-5-new');
  assert.equal(fresh.created, true);
  assert.equal(fresh.bot.userId, 12);
  assert.equal(fresh.bot.apiKey, 'K2');
});

test('provisioner never subscribes to a stream that does not exist', async () => {
  const { fetch, calls } = fakeZulip({
    'GET /get_stream_id': () => ({ result: 'error', msg: "Invalid channel name 'nope'", code: 'BAD_REQUEST' }),
  });
  const p = new Provisioner(new ZulipClient(creds, fetch));
  await assert.rejects(p.subscribe(5, 'nope'));
  assert.ok(!calls.includes('POST /users/me/subscriptions'));
});

test('provisioner treats unauthorized subscription as failure', async () => {
  const { fetch } = fakeZulip({
    'GET /get_stream_id': () => ({ result: 'success', stream_id: 3 }),
    'POST /users/me/subscriptions': () => ({ result: 'success', subscribed: {}, already_subscribed: {}, unauthorized: ['secret'] }),
  });
  const p = new Provisioner(new ZulipClient(creds, fetch));
  await assert.rejects(p.subscribe(5, 'secret'), /may not subscribe/);
});

test('lastPostOf: own bot key, sender:me, newest virtual anchor and seconds-to-ms conversion', async () => {
  const email = 'fuzzer-bot@example.org';
  const timestamps = [1794000180, 1794000900, 1794000960]; // 21:23, 21:35, 21:36Z
  const { fetch, calls } = fakeZulip({
    'GET /bots': () => ({ result: 'success', bots: [{ username: email, api_key: 'fixture-only-key' }] }),
    'GET /messages': (_body, url) => {
      assert.deepEqual(JSON.parse(url.searchParams.get('narrow')!), [{ operator: 'sender', operand: 'me' }]);
      assert.equal(url.searchParams.get('anchor'), 'newest');
      assert.equal(url.searchParams.get('num_before'), '1');
      assert.equal(url.searchParams.get('num_after'), '0');
      assert.equal(url.searchParams.get('include_anchor'), 'true');
      // 'newest' is a virtual anchor beyond the last message, not a real
      // included message. One message before it is the newest, not two rows.
      return { result: 'success', messages: timestamps.slice(-1).map((timestamp) => ({ timestamp })) };
    },
  });
  const provisioner = new Provisioner(new ZulipClient(creds, fetch));
  const posted = await provisioner.lastPostOf(email.toUpperCase(), (ownCreds) => {
    assert.deepEqual(ownCreds, { email, key: 'fixture-only-key', site: creds.site });
    return new ZulipClient(ownCreds, fetch);
  });
  assert.equal(posted, Date.parse('2026-11-06T21:36:00Z'));
  assert.deepEqual(calls, ['GET /bots', 'GET /messages']);
});

test('lastPostOf: successful empty history is distinct from an owner-list failure', async () => {
  for (const owned of [true, false]) {
    const { fetch } = fakeZulip({
      'GET /bots': () => owned
        ? { result: 'success', bots: [{ username: 'hand@example.org', api_key: 'fixture-key' }] }
        : { result: 'error', msg: 'owner lookup failed' },
      'GET /messages': () => ({ result: 'success', messages: [] }),
    });
    const p = new Provisioner(new ZulipClient(creds, fetch));
    const lookup = p.lastPostOf('hand@example.org', (c) => new ZulipClient(c, fetch));
    if (owned) assert.equal(await lookup, undefined);
    else await assert.rejects(lookup, /owner lookup failed/);
  }
});

test('lastPostOf: missing owned identity and bot-key query failures propagate', async () => {
  for (const owned of [true, false]) {
    const { fetch } = fakeZulip({
      'GET /bots': () => ({ result: 'success', bots: owned ? [{ username: 'hand@example.org', api_key: 'fixture-key' }] : [] }),
      'GET /messages': () => ({ result: 'error', msg: 'bot-key query failed' }),
    });
    const p = new Provisioner(new ZulipClient(creds, fetch));
    await assert.rejects(p.lastPostOf('hand@example.org', (c) => new ZulipClient(c, fetch)), owned ? /bot-key query failed/ : /not among the owner's bots/);
  }
});

test('admin rename PATCHes only full_name to the bot endpoint', async () => {
  const { fetch, calls } = fakeZulip({
    'PATCH /bots/42': body => {
      assert.deepEqual([...body], [['full_name', '[cc-opus-5-5] Scout']]);
      return { result: 'success' };
    },
  });
  await new Provisioner(new ZulipClient(creds, fetch)).rename(42, '[cc-opus-5-5] Scout');
  assert.deepEqual(calls, ['PATCH /bots/42']);
});

test('admin bot rename propagates failure for the actions warning boundary', async () => {
  const { fetch } = fakeZulip({ 'PATCH /bots/42': () => ({ result: 'error', msg: 'not permitted' }) });
  await assert.rejects(new Provisioner(new ZulipClient(creds, fetch)).rename(42, 'new'), /not permitted/);
});
