/**
 * Minimal Zulip REST client over fetch — only what the spawner needs.
 *
 * Zulip quirks handled here:
 *  - POST/PATCH bodies are form-encoded; arrays and objects are JSON strings,
 *    booleans the strings "true"/"false".
 *  - Errors come back as `{result: "error", msg, code}`, sometimes with a 4xx;
 *    both become a thrown ZulipApiError carrying `code` (BAD_EVENT_QUEUE_ID …).
 */
import { readFileSync } from 'node:fs';

export interface ZulipCreds {
  email: string;
  key: string;
  site: string;
}

/** Parse a zuliprc (`[api]` email/key/site). */
export function parseZuliprc(text: string): ZulipCreds {
  const values: Record<string, string> = {};
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      continue;
    }
    const kv = line.match(/^([^=]+)=(.*)$/);
    if (kv && section === 'api') values[kv[1].trim().toLowerCase()] = kv[2].trim();
  }
  if (!values.email || !values.key || !values.site) throw new Error('zuliprc needs [api] email, key and site');
  return { email: values.email, key: values.key, site: values.site.replace(/\/+$/, '') };
}

export function loadZuliprc(path: string): ZulipCreds {
  return parseZuliprc(readFileSync(path, 'utf8'));
}

export function renderZuliprc(c: ZulipCreds): string {
  return `[api]\nemail=${c.email}\nkey=${c.key}\nsite=${c.site}\n`;
}

export class ZulipApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ZulipApiError';
  }
}

type Params = Record<string, unknown>;

export function encodeParams(params: Params): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (typeof v === 'string') out.set(k, v);
    else if (typeof v === 'number' || typeof v === 'boolean') out.set(k, String(v));
    else out.set(k, JSON.stringify(v));
  }
  return out;
}

export interface ZulipMessage {
  id: number;
  type: 'stream' | 'private';
  sender_id: number;
  sender_full_name: string;
  sender_email: string;
  content: string;
  /** Topic (Zulip calls it subject on the wire). */
  subject: string;
  stream_id?: number;
  /** Stream name for stream messages; the participant list for DMs. */
  display_recipient: string | { id: number; email: string; full_name: string }[];
  timestamp: number;
  flags?: string[];
}

export interface ZulipEvent {
  id: number;
  type: string;
  message?: ZulipMessage;
  flags?: string[];
  op?: string;
  user_id?: number;
  message_id?: number;
}

export interface OwnedBot {
  username: string;
  full_name: string;
  api_key: string;
}

export type Fetch = typeof fetch;

export class ZulipClient {
  private readonly auth: string;

  constructor(
    readonly creds: ZulipCreds,
    private readonly fetchImpl: Fetch = fetch,
  ) {
    this.auth = 'Basic ' + Buffer.from(`${creds.email}:${creds.key}`).toString('base64');
  }

  get site(): string {
    return this.creds.site;
  }

  async call<T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    params: Params = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    const body = encodeParams(params);
    let url = `${this.creds.site}/api/v1${path}`;
    const init: RequestInit = {
      method,
      headers: { Authorization: this.auth },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    };
    if (method === 'GET') {
      const qs = body.toString();
      if (qs) url += `?${qs}`;
    } else {
      init.body = body;
      (init.headers as Record<string, string>)['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const res = await this.fetchImpl(url, init);
    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new ZulipApiError(`${method} ${path}: HTTP ${res.status}, non-JSON body`, undefined, res.status);
    }
    if (json.result !== 'success') {
      throw new ZulipApiError(`${method} ${path}: ${String(json.msg ?? `HTTP ${res.status}`)}`, json.code as string | undefined, res.status);
    }
    return json as T;
  }

  me(): Promise<{ user_id: number; full_name: string; email: string; is_bot: boolean; role: number }> {
    return this.call('GET', '/users/me');
  }

  user(idOrEmail: number | string): Promise<{ user: { user_id: number; full_name: string; email: string; is_bot: boolean; is_active: boolean } }> {
    return this.call('GET', `/users/${encodeURIComponent(String(idOrEmail))}`);
  }

  /** Recursive membership (subgroups count). */
  async isGroupMember(groupId: number, userId: number): Promise<boolean> {
    const r = await this.call<{ is_user_group_member: boolean }>('GET', `/user_groups/${groupId}/members/${userId}`, {
      direct_member_only: false,
    });
    return r.is_user_group_member;
  }

  register(eventTypes: string[]): Promise<{ queue_id: string; last_event_id: number; max_message_id?: number }> {
    return this.call('POST', '/register', {
      event_types: eventTypes,
      apply_markdown: false,
      fetch_event_types: ['message'],
    });
  }

  events(queueId: string, lastEventId: number): Promise<{ events: ZulipEvent[] }> {
    // Long poll: Zulip holds the request ~90s when idle.
    return this.call('GET', '/events', { queue_id: queueId, last_event_id: lastEventId }, { timeoutMs: 120_000 });
  }

  async sendStream(stream: string, topic: string, content: string): Promise<number> {
    const r = await this.call<{ id: number }>('POST', '/messages', { type: 'stream', to: stream, topic, content });
    return r.id;
  }

  async sendDm(userIds: number[], content: string): Promise<number> {
    const r = await this.call<{ id: number }>('POST', '/messages', { type: 'direct', to: userIds, content });
    return r.id;
  }

  async messages(
    narrow: unknown[],
    anchor: number | 'newest',
    numBefore: number,
    numAfter: number,
    includeAnchor = true,
  ): Promise<ZulipMessage[]> {
    const r = await this.call<{ messages: ZulipMessage[] }>('GET', '/messages', {
      narrow,
      anchor: String(anchor),
      num_before: numBefore,
      num_after: numAfter,
      include_anchor: includeAnchor,
      apply_markdown: false,
    });
    return r.messages;
  }

  /** Bots owned by this (human) account, with their API keys. */
  async ownedBots(): Promise<OwnedBot[]> {
    const r = await this.call<{ bots: OwnedBot[] }>('GET', '/bots');
    return r.bots;
  }

  /** Create a generic bot. Needs a human account in can_create_bots_group. */
  createBot(fullName: string, shortName: string): Promise<{ user_id?: number; api_key?: string }> {
    return this.call('POST', '/bots', { full_name: fullName, short_name: shortName, bot_type: 1 });
  }

  /** Subscribe `principals` (user ids) to streams by name. NB Zulip CREATES a
   *  stream that doesn't exist — callers check it exists first (streamId). */
  subscribe(streams: string[], principals: number[]): Promise<{ subscribed: Record<string, string[]>; already_subscribed: Record<string, string[]>; unauthorized?: string[] }> {
    return this.call('POST', '/users/me/subscriptions', {
      subscriptions: streams.map((name) => ({ name })),
      principals,
    });
  }

  /** Id of an existing stream; throws if there is none by that name. */
  async streamId(name: string): Promise<number> {
    const r = await this.call<{ stream_id: number }>('GET', '/get_stream_id', { stream: name });
    return r.stream_id;
  }
}
