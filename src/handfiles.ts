/**
 * The files a hand runs on, all in its own directory under handsDir and all
 * written as the agents user:
 *
 *   <handDir>/zuliprc                      the hand's bot credentials (0600)
 *   <handDir>/mcpl-bridge.json             MCPL_BRIDGE_CONFIG: zulip_mcp under the bridge
 *   <handDir>/zulip-state/                 zulip_mcp state (watermarks — kept across revivals,
 *                                          so catch-up after downtime works)
 *   <handDir>/zulip-state/filters.json     written directly every launch (env seeds only apply
 *                                          once and break on commas)
 *   <handDir>/seed.md                      first user turn
 */
import { join } from 'node:path';
import type { SpawnerConfig } from './config.js';
import type { AgentHost } from './host.js';
import { renderZuliprc, type ZulipCreds } from './zulip.js';

export interface HandPaths {
  dir: string;
  zuliprc: string;
  bridgeConfig: string;
  stateDir: string;
  filters: string;
  seed: string;
}

export function handPaths(handsDir: string, shortName: string, existingDir?: string): HandPaths {
  const dir = existingDir ?? join(handsDir, shortName);
  const stateDir = join(dir, 'zulip-state');
  return {
    dir,
    zuliprc: join(dir, 'zuliprc'),
    bridgeConfig: join(dir, 'mcpl-bridge.json'),
    stateDir,
    filters: join(stateDir, 'filters.json'),
    seed: join(dir, 'seed.md'),
  };
}

/** zulip_mcp's MCPL channel id for a stream. */
export const streamChannelId = (stream: string): string => `zulip:${stream}`;

/**
 * Wake policy (operator decision): any mention, reply or DM wakes the hand,
 * bots included — like upstream cc-spawner hands. Ambient traffic is held and
 * folded into the next wake. The bridge expands chat:mention / chat:reply /
 * chat:dm into chat:addressed.
 */
export const HAND_WAKE_POLICY = {
  wake: [['chat:addressed'], ['chat:dm']],
  hold: [['chat:ambient']],
};

/**
 * The bridge's default grant, plus the two channel extras it leaves out
 * (streaming, typing — it never uses them). zulip_mcp's `zulip.messaging`
 * feature set lists `channels.streaming` among its uses, and the bridge
 * disables a feature set whole when any use is not granted: without these the
 * hand has no zulip__send_message and falls back to mcpl_send, which cannot
 * pick a topic.
 */
export const HAND_GRANT = [
  'tools',
  'pushEvents',
  'modelInfo',
  'inferenceRequest',
  'inferenceLifecycle',
  'channels.register',
  'channels.lifecycle',
  'channels.incoming',
  'channels.publish',
  'channels.acknowledge',
  'channels.streaming',
  'channels.typing',
  'contextHooks.beforeInference.observe',
  'contextHooks.beforeInference.inject.beforeUser',
];

export function renderBridgeConfig(cfg: SpawnerConfig, shortName: string, stream: string, p: HandPaths): object {
  return {
    servers: {
      zulip: {
        transport: {
          command: cfg.nodeBin,
          args: [cfg.zulipMcp],
          env: {
            ZULIP_RC_PATH: p.zuliprc,
            ZULIP_SESSION_ID: shortName,
            ZULIP_STATE_DIR: p.stateDir,
            ZULIP_FILTERS_FILE: p.filters,
            ZULIP_CATCHUP_LIMIT: String(cfg.catchupLimit),
          },
        },
        grant: HAND_GRANT,
        enableFeatureSets: ['*'],
        // A crashed stdio server is not restarted by default — a deaf hand.
        reconnect: true,
        wake: HAND_WAKE_POLICY,
        openChannels: [streamChannelId(stream)],
        openChannelsOnly: true,
        dmAllowlist: cfg.handDmAllowlist,
      },
    },
  };
}

export function renderFilters(stream: string): object {
  return { streams: [stream] };
}

export interface SeedContext {
  personaName: string;
  streamName: string;
  topic: string;
  realm: string;
}

/** Zulip-flavoured upstream seed. Replies are pinned to an explicit stream +
 *  topic: zulip_mcp routes `mcpl_send` to the newest message's topic. */
export function buildSeedPrompt(ctx: SeedContext): string {
  return `You're connected to Zulip (${ctx.realm}) as @**${ctx.personaName}**, through the zulip MCP tools. \
Your home is stream #${ctx.streamName}, topic "${ctx.topic}". Mentions of you (and DMs, where allowed) wake you; \
other traffic in #${ctx.streamName} reaches you as context on your next wake. \
Always reply with zulip__send_message (type "stream", to "${ctx.streamName}", topic "${ctx.topic}" unless the \
conversation is clearly in another topic) — never rely on a default topic. Don't answer other bots just to \
acknowledge them. Have a look at the recent backscroll and say hi when you're ready.
`;
}

/** Re-entry note for a resumed session — kept from upstream on purpose. */
export function buildResumePrompt(ctx: SeedContext & { awaySince?: string }): string {
  const gap = ctx.awaySince ? ` You were stopped ${ctx.awaySince}.` : '';
  return `You're back, and this is the same session you left — your earlier context is intact.${gap} \
The channel has carried on without you, so catch up on the recent backscroll in \
#${ctx.streamName} > ${ctx.topic} before you say anything. Reply there with zulip__send_message \
(stream "${ctx.streamName}", topic "${ctx.topic}").
`;
}

export async function writeHandFiles(
  host: AgentHost,
  cfg: SpawnerConfig,
  shortName: string,
  stream: string,
  creds: ZulipCreds,
  seedText: string,
  existingDir?: string,
): Promise<HandPaths> {
  const p = handPaths(cfg.handsDir, shortName, existingDir);
  await host.mkdirp(p.stateDir);
  await host.writeFile(p.zuliprc, renderZuliprc(creds), 0o600);
  await host.writeFile(p.filters, JSON.stringify(renderFilters(stream), null, 2) + '\n', 0o600);
  await host.writeFile(p.bridgeConfig, JSON.stringify(renderBridgeConfig(cfg, shortName, stream, p), null, 2) + '\n', 0o600);
  await host.writeFile(p.seed, seedText, 0o600);
  return p;
}

/** Codex has a separate live queue: never let a later tool read expand catch-up. */
export function buildCodexPrompt(ctx: SeedContext, through: number, resume: boolean): string {
  return `You're ${resume ? 'back in the same session; your earlier context is intact' : 'connected to Zulip as ' + ctx.personaName}.
Your home is #${ctx.streamName} > ${ctx.topic}. Reply with the Zulip MCP send_message tool (stream "${ctx.streamName}", topic "${ctx.topic}").
Catch-up boundary: message id <= ${through}. Read recent home-topic backscroll only through this inclusive boundary.
Answer only still-unanswered mentions addressed to you within that boundary; do not repeat answers already in your earlier conversation or backscroll. Messages already delivered in your earlier conversation are not new requests: finish any pending work there rather than admitting them again from backscroll.
Messages with id > ${through} belong exclusively to the spawner wake queue, including messages you see in tool results during catch-up. Do not answer those from backscroll; wait for their queued delivery.
Only home-topic mentions wake you. Other backscroll is context, not a request to answer. ${resume ? '' : 'Say hi when ready.'}
`;
}
