/**
 * Posting into Zulip as the spawner bot. Every failure is logged and swallowed:
 * a notice that could not be posted must never break a sweep or a command.
 */
import type { Where } from './auth.js';
import type { BotEntry } from './registry.js';
import type { ZulipClient } from './zulip.js';

const log = (msg: string) => console.log(`${new Date().toISOString()} [notify] ${msg}`);

/** Zulip's limit is 10000 characters; leave room for the chunk marker. */
export const MESSAGE_BUDGET = 9500;

export interface Notifier {
  /** Post in a hand's home topic. Returns the message id. */
  postHome(entry: Pick<BotEntry, 'streamName' | 'topic'>, content: string): Promise<number | undefined>;
  /** Reply where a command came from. */
  reply(where: Where, content: string): Promise<void>;
  dm(userIds: number[], content: string): Promise<void>;
}

/** Split on line boundaries under the budget; never empty. */
export function splitContent(content: string, limit = MESSAGE_BUDGET): string[] {
  if (content.length <= limit) return [content.length > 0 ? content : '(empty)'];
  const out: string[] = [];
  let current = '';
  for (const line of content.split('\n')) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) out.push(current);
    let rest = line;
    while (rest.length > limit) {
      out.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    current = rest;
  }
  if (current) out.push(current);
  return out.length > 0 ? out : ['(empty)'];
}

export class ZulipNotifier implements Notifier {
  constructor(private readonly client: ZulipClient) {}

  async postHome(entry: Pick<BotEntry, 'streamName' | 'topic'>, content: string): Promise<number | undefined> {
    let first: number | undefined;
    for (const chunk of splitContent(content)) {
      try {
        const id = await this.client.sendStream(entry.streamName, entry.topic, chunk);
        first ??= id;
      } catch (err) {
        log(`post to #${entry.streamName} > ${entry.topic} failed: ${(err as Error).message}`);
        return first;
      }
    }
    return first;
  }

  async reply(where: Where, content: string): Promise<void> {
    if (where.kind === 'stream') {
      await this.postHome({ streamName: where.streamName, topic: where.topic }, content);
    } else {
      await this.dm(where.userIds, content);
    }
  }

  async dm(userIds: number[], content: string): Promise<void> {
    for (const chunk of splitContent(content)) {
      try {
        await this.client.sendDm(userIds, chunk);
      } catch (err) {
        log(`DM to ${userIds.join(',')} failed: ${(err as Error).message}`);
        return;
      }
    }
  }
}
