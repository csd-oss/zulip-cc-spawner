/**
 * Hand identities — one Zulip generic bot per hand, owned by the operator's
 * (human) account, whose key is used here and nowhere else.
 *
 * NB a bot may post to any stream its OWNER is subscribed to (Zulip
 * zerver/lib/streams.py, access_stream_for_send_message). The owner should be
 * a dedicated service account with few private streams (docs/PLAN.md).
 */
import { ZulipApiError, type ZulipClient, type ZulipCreds } from './zulip.js';

const log = (msg: string) => console.log(`${new Date().toISOString()} [provision] ${msg}`);

export interface BotIdentity {
  userId: number;
  email: string;
  apiKey: string;
}

/** Zulip builds a bot's email as `<short_name>-bot@<realm host>`. */
export function botEmailPrefix(shortName: string): string {
  return `${shortName.toLowerCase()}-bot@`;
}

export class Provisioner {
  constructor(private readonly admin: ZulipClient) {}

  /** An owned bot with this short name, with its key, or undefined. */
  async find(shortName: string): Promise<BotIdentity | undefined> {
    const prefix = botEmailPrefix(shortName);
    const bot = (await this.admin.ownedBots()).find((b) => b.username.toLowerCase().startsWith(prefix));
    if (!bot) return undefined;
    const { user } = await this.admin.user(bot.username);
    return { userId: user.user_id, email: bot.username, apiKey: bot.api_key };
  }

  /**
   * Find, else create. A create that errors or times out may still have
   * happened server-side, so the owned-bot list is re-read before giving up.
   */
  async ensure(fullName: string, shortName: string): Promise<{ bot: BotIdentity; created: boolean }> {
    const existing = await this.find(shortName);
    if (existing) return { bot: existing, created: false };
    try {
      await this.admin.createBot(fullName, shortName);
      log(`created bot ${fullName} (${shortName})`);
    } catch (err) {
      const again = await this.find(shortName).catch(() => undefined);
      if (again) {
        log(`create of ${shortName} reported "${(err as Error).message}" but the bot exists — using it`);
        return { bot: again, created: true };
      }
      throw new Error(explain(err as Error, shortName));
    }
    const bot = await this.find(shortName);
    if (!bot) throw new Error(`created bot ${shortName} but cannot find it among the owner's bots`);
    return { bot, created: true };
  }

  /** Subscribe a bot to an EXISTING stream (Zulip would create a missing one). */
  async subscribe(botUserId: number, streamName: string): Promise<void> {
    await this.admin.streamId(streamName); // throws if the stream does not exist
    const r = await this.admin.subscribe([streamName], [botUserId]);
    if (r.unauthorized?.length) {
      throw new Error(`the bot owner may not subscribe bots to #${streamName} (private stream they are not in?)`);
    }
  }

  /**
   * Epoch ms of the newest message a hand's bot sent, anywhere. Asked with the
   * bot's OWN key (`sender:me`), so posts in streams the spawner is not in
   * count too. Bots' keys come from the owner's bot list.
   */
  async lastPostOf(botEmail: string, makeClient: (c: ZulipCreds) => ZulipClient): Promise<number | undefined> {
    const bot = (await this.admin.ownedBots()).find((b) => b.username.toLowerCase() === botEmail.toLowerCase());
    if (!bot) throw new Error(`${botEmail} is not among the owner's bots`);
    const own = makeClient({ email: bot.username, key: bot.api_key, site: this.admin.site });
    const [m] = await own.messages([{ operator: 'sender', operand: 'me' }], 'newest', 1, 0);
    return m ? m.timestamp * 1000 : undefined;
  }

  credsFor(bot: BotIdentity): ZulipCreds {
    return { email: bot.email, key: bot.apiKey, site: this.admin.site };
  }
}

function explain(err: Error, shortName: string): string {
  const m = err.message;
  if (/already in use|already exists/i.test(m)) {
    return `a bot named ${shortName} exists but is not active under the owner — reactivate it in Settings → Bots, or pick another name (${m})`;
  }
  if (err instanceof ZulipApiError && (err.status === 403 || /permission|not allowed/i.test(m))) {
    return `the bot owner account may not create bots (${m})`;
  }
  return `could not create bot ${shortName}: ${m}`;
}
