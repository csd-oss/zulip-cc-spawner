/**
 * Authorization. Fail closed on every uncertain path: stream not allow-listed,
 * group lookup failed, empty allow-lists.
 *
 * Order: stream gate (stream messages) → resident leg (bot senders) → user legs
 * (allowedUsers, then allowedGroups via Zulip's recursive membership check).
 */
import type { ZulipClient } from './zulip.js';

export interface Invoker {
  userId: number;
  /** Full name, for audit strings. */
  name: string;
  /** 'resident' = a bot sender (another agent), 'user' = a human. */
  kind: 'user' | 'resident';
}

export type Where =
  | { kind: 'stream'; streamName: string; streamId: number; topic: string }
  | { kind: 'dm'; userIds: number[] };

export interface AuthConfig {
  allowedStreams: string[];
  allowedUsers: number[];
  allowedGroups: number[];
  allowedResidents: number[];
}

export interface AuthResult {
  ok: boolean;
  reason?: string;
}

export type GroupCheck = (groupId: number, userId: number) => Promise<boolean>;

/** `"*"` allows every stream the spawner is subscribed to (it hears no others). */
export function streamAllowed(streamName: string, cfg: Pick<AuthConfig, 'allowedStreams'>): boolean {
  const s = streamName.toLowerCase();
  return cfg.allowedStreams.some((a) => a === '*' || a.toLowerCase() === s);
}

export async function isAllowed(inv: Invoker, where: Where, cfg: AuthConfig, isMember: GroupCheck): Promise<AuthResult> {
  if (where.kind === 'stream' && !streamAllowed(where.streamName, cfg)) {
    return { ok: false, reason: `#${where.streamName} is not allow-listed for the spawner` };
  }
  if (inv.kind === 'resident') {
    return cfg.allowedResidents.includes(inv.userId)
      ? { ok: true }
      : { ok: false, reason: 'this bot is not allow-listed to drive the spawner' };
  }
  if (cfg.allowedUsers.includes(inv.userId)) return { ok: true };
  if (cfg.allowedGroups.length === 0) {
    return { ok: false, reason: 'you are not allow-listed — ask the operator to configure the spawner' };
  }
  let lookupFailed = false;
  for (const g of cfg.allowedGroups) {
    try {
      if (await isMember(g, inv.userId)) return { ok: true };
    } catch {
      lookupFailed = true;
    }
  }
  return {
    ok: false,
    reason: lookupFailed ? 'could not verify your group membership' : 'you are not in an allow-listed group',
  };
}

const GROUP_CACHE_TTL_MS = 60_000;

/** Recursive group membership via the spawner bot's own API access, cached 60s. */
export class GroupChecker {
  private cache = new Map<string, { member: boolean; at: number }>();

  constructor(private readonly client: ZulipClient) {}

  check: GroupCheck = async (groupId, userId) => {
    const key = `${groupId}:${userId}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < GROUP_CACHE_TTL_MS) return hit.member;
    const member = await this.client.isGroupMember(groupId, userId);
    this.cache.set(key, { member, at: Date.now() });
    return member;
  };
}
