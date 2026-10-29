/**
 * Create (or find) the spawner's own Zulip bot and write its zuliprc. Safe to
 * rerun: an owned bot with the same short name is reused, never duplicated.
 *
 *   node dist/src/setup-bot.js --owner owner.zuliprc --out spawner.zuliprc \
 *     [--name "CC Spawner"] [--short cc-spawner] [--subscribe <stream>]…
 *
 * The bot belongs to the owner account (the one that also creates the hands'
 * bots). Streams must already exist; the bot hears only streams it is
 * subscribed to, so with `allowedStreams: ["*"]` adding it to a stream later
 * (in Zulip) is how the spawner gets there. The key is written, never printed.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Provisioner } from './provision.js';
import { loadZuliprc, renderZuliprc, ZulipClient, type ZulipCreds } from './zulip.js';

export interface SetupOptions {
  owner: ZulipCreds;
  out: string;
  name: string;
  short: string;
  subscribe: string[];
}

export interface SetupResult {
  userId: number;
  email: string;
  created: boolean;
  written: boolean;
  subscribed: string[];
}

export async function setupSpawnerBot(opts: SetupOptions, makeClient = (c: ZulipCreds) => new ZulipClient(c)): Promise<SetupResult> {
  const owner = makeClient(opts.owner);
  const ownerMe = await owner.me();
  if (ownerMe.is_bot) throw new Error(`--owner must be a person's zuliprc; ${opts.owner.email} is a bot`);
  const provisioner = new Provisioner(owner);
  const { bot, created } = await provisioner.ensure(opts.name, opts.short);
  const creds: ZulipCreds = { email: bot.email, key: bot.apiKey, site: opts.owner.site };
  const me = await makeClient(creds).me();
  if (me.user_id !== bot.userId) throw new Error(`${bot.email} logs in as user ${me.user_id}, expected ${bot.userId}`);
  for (const stream of opts.subscribe) await provisioner.subscribe(bot.userId, stream);
  const text = renderZuliprc(creds);
  const written = !existsSync(opts.out) || readFileSync(opts.out, 'utf8') !== text;
  if (written) writeFileSync(opts.out, text, { mode: 0o600 });
  chmodSync(opts.out, 0o600);
  return { userId: bot.userId, email: bot.email, created, written, subscribed: opts.subscribe };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      owner: { type: 'string' },
      out: { type: 'string' },
      name: { type: 'string', default: 'CC Spawner' },
      short: { type: 'string', default: 'cc-spawner' },
      subscribe: { type: 'string', multiple: true, default: [] },
    },
  });
  if (!values.owner || !values.out) {
    console.error('usage: setup-bot --owner owner.zuliprc --out spawner.zuliprc [--name "CC Spawner"] [--short cc-spawner] [--subscribe <stream>]…');
    process.exit(2);
  }
  const r = await setupSpawnerBot({
    owner: loadZuliprc(values.owner),
    out: values.out,
    name: values.name!,
    short: values.short!,
    subscribe: values.subscribe!,
  });
  console.log(`${r.created ? 'created' : 'found'} ${values.name} — user ${r.userId}, ${r.email}`);
  for (const s of r.subscribed) console.log(`subscribed to #${s}`);
  console.log(`${values.out}: ${r.written ? 'written' : 'unchanged'} (0600)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: Error) => {
    console.error(`setup-bot: ${err.message}`);
    process.exit(1);
  });
}
