import { listActivity, listHome, listIdentity, listTable, listText } from './list-format.js';
import { formatWorkdirSize, workdirSizes } from './workdir-size.js';
import { PREPARE_HANDDIR_JS } from './directory-owner.js';
/**
 * SpawnerActions — the core. The Zulip control surface builds an Invocation
 * and calls run(); the returned result is the reply.
 *
 * All mutating work (commands, reaper and watcher sweeps) is serialized through
 * one queue: tmux, the registry and the hands' files are shared state.
 *
 * Spawn is written as a provisioning record BEFORE any side effect (bot,
 * files, tmux), so a failure or a crash mid-spawn leaves a record of what may
 * exist; the reaper's startup reconcile closes it out.
 */
import { CodexLauncher, inferEngine } from './codex.js';
import { isPlausibleMessageTime } from './activity-time.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { prepareWorkDir } from './workdir.js';
import { ProcessLivenessError, deletionPaths, handStopped, type CheckedDeletionPath, type DeletionPath } from './delete-hand.js';
import { handIdentityName, handName, isHandTarget, modelDisplayName } from './names.js';
import { isAllowed, type GroupCheck, type Invoker, type Where } from './auth.js';
import {
  EFFORT_DEFAULT,
  PEEK_DEFAULT_LINES,
  USAGE,
  buildAnswerCommand,
  effortError,
  resolveModel,
  modelSlug,
  modelsListing,
  type Command,
} from './commands.js';
import type { SpawnerConfig } from './config.js';
import { buildCodexPrompt, buildResumePrompt, buildSeedPrompt, writeHandFiles, handPaths } from './handfiles.js';
import type { AgentHost } from './host.js';
import type { ClaudeLauncher } from './launcher.js';
import type { Notifier } from './notifier.js';
import type { Provisioner } from './provision.js';
import { LiveModelSwitcher } from './model-switch.js';
import { injectAnswer, parseAnswerSpec, PartialAnswerError } from './question.js';
import type { BotEntry, Registry } from './registry.js';
import type { Tmux } from './tmux.js';
import type { TranscriptWatcher } from './transcript-watch.js';

const log = (msg: string) => console.log(`${new Date().toISOString()} [actions] ${msg}`);

/** `press` key words → tmux key names. Anything else is sent as literal text. */
const KEY_NAMES: Record<string, string> = {
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', 'shift-tab': 'BTab',
  space: 'Space', up: 'Up', down: 'Down', left: 'Left', right: 'Right', backspace: 'BSpace',
  'ctrl-c': 'C-c', '^c': 'C-c', 'ctrl-u': 'C-u', '^u': 'C-u', 'ctrl-d': 'C-d', '^d': 'C-d',
};

/** Peek output must fit one Zulip message with its header and fences. */
const PEEK_INLINE_BUDGET = 8500;

export interface Invocation {
  cmd: Command;
  /** The message body with leading mentions stripped (for the answer shortcut). */
  body: string;
  where: Where;
  invoker: Invoker;
}

export interface ActionResult {
  content: string;
  /** Deliver to the invoker by DM rather than where the command came from. */
  private?: boolean;
}

export interface ActionDeps {
  config: SpawnerConfig;
  registry: Registry;
  host: AgentHost;
  tmux: Tmux;
  provisioner: Provisioner;
  launcher: ClaudeLauncher;
  notifier: Notifier;
  watcher: TranscriptWatcher;
  groupCheck: GroupCheck;
  realm: string;
  modelSwitcher?: LiveModelSwitcher;
  codexBoundary?: (entry: BotEntry) => Promise<number>;
  codexWake?: { ready(entry: BotEntry): void };
}

function modelLabel(e: { model: string; effort?: string }): string {
  return e.effort ? `${e.model}, effort ${e.effort}` : e.model;
}

function formatIdle(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${Math.round((seconds % 3600) / 60)}m`;
}

const home = (e: Pick<BotEntry, 'streamName' | 'topic'>) => `#${e.streamName} > ${e.topic}`;

export class SpawnerActions {
  private legacyDeletes = new Map<string, { token: string; signature: string; expires: number }>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: ActionDeps) {}

  /** Serialize a task onto the shared mutation queue (also used by sweeps). */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const p = this.queue.then(task);
    this.queue = p.catch((err) => log(`queued task error: ${(err as Error).stack ?? err}`));
    return p;
  }

  run(inv: Invocation): Promise<ActionResult> {
    return this.enqueue(() => this.execute(inv));
  }

  private async execute(inv: Invocation): Promise<ActionResult> {
    // Hands can't drive the spawner: keeps the delegation tree one level deep.
    if (inv.invoker.kind === 'resident' && this.d.registry.all().some((e) => e.botUserId === inv.invoker.userId)) {
      log(`denied spawned hand ${inv.invoker.name} (${inv.invoker.userId})`);
      return { content: 'Spawned hands cannot drive the spawner.' };
    }
    const auth = await isAllowed(inv.invoker, inv.where, this.d.config, this.d.groupCheck);
    if (!auth.ok) {
      log(`denied ${inv.invoker.name} (${inv.invoker.userId}): ${auth.reason}`);
      return { content: `Not authorized: ${auth.reason}` };
    }
    const cmd = this.resolveShortcut(inv);
    if ('target' in cmd && this.d.registry.matchingHands(cmd.target).length > 1) {
      return { content: 'Ambiguous hand name — use a target shown by `list` or `list stopped`; nothing was changed.' };
    }
    log(`command from ${inv.invoker.name} (${inv.invoker.userId}): ${JSON.stringify(cmd)}`);
    switch (cmd.kind) {
      case 'spawn':
        return { content: await this.spawn(inv, cmd) };
      case 'model':
        return { content: await this.model(inv, cmd) };
      case 'rename':
        return { content: await this.rename(inv, cmd.target, cmd.friendly) };
      case 'models':
        return { content: modelsListing() };
      case 'list':
        return { content: cmd.stopped ? await this.listStopped(cmd.bySize, cmd.creator === 'mine' ? inv.invoker.userId : cmd.creator) : this.list() };
      case 'delete':
        return { content: await this.deleteHand(inv, cmd.target, cmd.confirm, cmd.forceLegacy, cmd.legacyToken) };
      case 'stop':
        return { content: await this.stop(inv, cmd.target) };
      case 'peek':
        return this.peek(cmd.target, cmd.lines, cmd.here);
      case 'answer':
        return { content: await this.answer(inv, cmd.target, cmd.spec) };
      case 'press':
        return { content: await this.press(inv, cmd.target, cmd.keys) };
      case 'rescan':
        return { content: await this.rescan() };
      case 'help':
        return { content: cmd.error ? `${cmd.error}\n${USAGE}` : USAGE };
    }
  }

  /**
   * Zulip has no reply-to, so the stand-in for upstream's "reply to the
   * question post": in a topic where exactly one hand is blocked on a dialog,
   * a bare `@spawner 2` / `yes` / `esc` / `text: …` answers it. Resolved here,
   * inside the serialized step, against the current pending state.
   */
  private resolveShortcut(inv: Invocation): Command {
    if (inv.cmd.kind !== 'help' || !inv.cmd.unknownVerb || inv.where.kind !== 'stream') return inv.cmd;
    const { streamId, topic } = inv.where;
    const blocked = this.d.registry
      .alive()
      .filter((e) => (e.pendingQuestion || e.pendingModelMenu) && e.streamId === streamId && e.topic.toLowerCase() === topic.toLowerCase());
    return blocked.length === 1 ? buildAnswerCommand(this.d.registry.commandTarget(blocked[0]), inv.body) : inv.cmd;
  }

  // ── spawn ──

  private async spawn(inv: Invocation, cmd: Command & { kind: 'spawn' }): Promise<string> {
    const where = inv.where;
    if (where.kind !== 'stream') {
      return 'Spawn from the stream and topic that should be the hand\'s home — not from a DM.';
    }
    const { config: cfg, registry, tmux } = this.d;
    const active = registry.occupied().length;
    if (active >= cfg.maxSessions) return `At capacity (${active}/${cfg.maxSessions} hands). \`stop\` one first.`;

    const suffix = (cmd.friendly ?? (await this.freshSuffix())).toLowerCase();
    const engine = cmd.engine ?? inferEngine(cmd.model);
    const slug = modelSlug(cmd.model);
    const matches = cmd.friendly ? registry.matchingHands(cmd.friendly) : [];
    const ambiguous = 'Ambiguous historical name — use a target shown by `list stopped`; nothing was changed.';
    // Explicit/current unique targets revive that identity, not a new hand whose
    // suffix happens to be its tmux name. A reserved target never creates a bot.
    let prior = matches.length === 1 ? matches[0] : undefined;
    if (cmd.friendly !== undefined && isHandTarget(cmd.friendly) && !prior) return 'Hand target not found; nothing was changed.';
    if (!prior) {
      // Preserve model-qualified legacy revival, but do not let latestFor pick
      // a winner when the exact persona itself belongs to distinct identities.
      const exactNames = [
        ...(engine === 'codex' ? [] : [`Claude-Code-${slug}-${suffix}`]),
        `[${engine === 'codex' ? 'cx' : 'cc'}-${slug}] ${suffix}`,
      ].map(handIdentityName);
      const exact = new Set(registry.all().filter(e => e.status !== 'provisioning' && e.botUserId > 0 &&
        exactNames.includes(handIdentityName(e.personaName))).map(e => e.tmuxSession));
      if (exact.size > 1) return ambiguous;
      if (exact.size === 1) prior = registry.currentHands().find(e => exact.has(e.tmuxSession));
      else if (matches.length > 1) return ambiguous;
    }
    if (prior && /^\[/.test(prior.personaName) && !prior.nameScheme) return 'Name collision with a legacy persona — pick another name.';
    let names: ReturnType<typeof handName>;
    try {
      // Only new identities are constrained by the friendly-name length limit.
      names = prior ? { personaName: prior.personaName, shortName: prior.tmuxSession }
        : handName(cmd.model, cmd.friendly ?? suffix, engine === 'codex' ? 'cx' : 'cc', cmd.effort);
    } catch { return 'Invalid hand name — use 1-24 chars of [A-Za-z0-9-], or a target from `list stopped`.'; }
    const personaName = prior?.personaName ?? names.personaName;
    const shortName = prior?.tmuxSession ?? names.shortName;
    const workDir = prior ? prior.workDir : resolve(cfg.workRoot ?? resolve(cfg.projectDir, 'hands'), shortName);
    if (!prior && registry.all().some((e) => e.tmuxSession === shortName && handIdentityName(e.personaName) !== handIdentityName(personaName))) {
      return 'Name collision with an existing identity — pick another name.';
    }

    const clash = prior ? registry.occupied().find(e => e.tmuxSession === prior.tmuxSession) : registry.busy(suffix);
    if (clash) {
      return `\`${suffix}\` is taken by **${clash.personaName}** (${clash.model}) — \`stop ${registry.commandTarget(clash)}\` first, or spawn without a name for a fresh hand.`;
    }
    if (await tmux.hasSession(shortName)) {
      return `tmux session \`${shortName}\` already exists outside my registry — pick another name or clean it up.`;
    }

    const rehome = prior && (prior.streamId !== where.streamId || prior.topic !== where.topic);
    // Legacy entries may store a raw short name (`fable-5-2`): reviving onto
    // its resolved id is a repair, not a model change.
    const modelChange = prior && resolveModel(prior.model) !== cmd.model;
    if (prior && (prior.engine ?? inferEngine(prior.model)) !== engine) {
      return 'Cannot change engine: Claude and Codex sessions are incompatible. Spawn a new hand with a different name instead.';
    }
    if (prior && (modelChange || rehome) && !this.canControl(inv, prior)) return this.ownerRefusal(prior);

    // Effort is not part of the identity: kept from the prior launch unless
    // overridden; `effort=default` clears it.
    const effort = cmd.effort === EFFORT_DEFAULT ? undefined : cmd.effort ?? prior?.effort;
    if (effort && !cmd.effort) {
      const error = effortError(effort, cmd.model, engine);
      if (error) return `Stored ${error} (or \`effort=${EFFORT_DEFAULT}\`).`;
    }

    // Continuity: resume the same transcript when it still exists.
    const priorSession = prior?.sessionId;
    let canResume = false;
    if (engine === 'codex') canResume = Boolean(priorSession);
    if (priorSession && engine !== 'codex') {
      try {
        canResume = await this.d.host.exists(this.d.watcher.transcriptPath(priorSession, workDir));
      } catch (err) {
        // Unsure ≠ missing: never start amnesiac because sudo hiccuped.
        return `Could not check **${personaName}**'s previous conversation (${(err as Error).message}) — nothing was started.`;
      }
    }
    const sessionId = canResume ? priorSession! : engine === 'codex' ? '' : randomUUID();
    // A failed first launch may never have written a transcript — not "lost".
    const lostContext = Boolean(prior) && !canResume && (engine === 'codex' || prior?.status !== 'failed');

    const paths = handPaths(cfg.handsDir, shortName, prior?.handDir);
    if (workDir && resolve(workDir) === resolve(paths.dir)) return 'workRoot must be separate from handsDir — refusing a non-empty working directory.';
    const now = new Date().toISOString();
    const entry: BotEntry = {
      suffix: prior?.suffix ?? suffix,
      ...(prior?.friendlyName !== undefined ? { friendlyName: prior.friendlyName } : {}),
      ...(prior?.nameAliases ? { nameAliases: [...prior.nameAliases] } : {}),
      personaName,
      botUserId: 0,
      botEmail: '',
      botCreatedBySpawner: prior?.botCreatedBySpawner,
      tmuxSession: shortName,
      streamName: prior?.streamName ?? where.streamName,
      streamId: prior?.streamId ?? where.streamId,
      topic: prior?.topic ?? where.topic,
      handDir: paths.dir,
      handDirReady: false,
      workDir,
      workDirReady: undefined,
      nameScheme: prior ? prior.nameScheme : 'stable-v2',
      harness: engine === 'codex' ? 'cx' : prior ? prior.harness : 'cc',
      engine,
      model: prior?.model ?? cmd.model,
      effort: prior ? prior.effort : effort,
      sessionId,
      spawnedBy: prior?.spawnedBy,
      spawnedAt: now,
      lastActivity: now,
      status: 'provisioning',
      seedFile: paths.seed,
    };
    if (!prior && registry.nameCollision(entry, true)) return 'Name collision with an existing identity — pick another name.';
    registry.add(entry);

    // Destination is staged: failed revivals must still resolve at the old home.
    const destination = { streamName: where.streamName, streamId: where.streamId, topic: where.topic };
    const savedFiles = new Map<string, Buffer | undefined>();
    let filesTouched = false;
    let launchSucceeded = false;
    let codexCatchupThrough = prior?.codexCatchupThrough;
    let launched = false;
    try {
      const { bot, created } = await this.d.provisioner.ensure(personaName, shortName, !prior?.botUserId);
      registry.update(entry, {
        botUserId: bot.userId, botEmail: bot.email,
        botCreatedBySpawner: created || (prior?.botUserId === bot.userId && prior.botCreatedBySpawner === true),
        ...(!prior?.botUserId && created ? { spawnedBy: { userId: inv.invoker.userId, username: inv.invoker.name } } : {}),
      });
      if (!created && !prior) log(`${personaName}: reusing an existing bot ${bot.email} with no registry history`);
      await this.d.provisioner.subscribe(bot.userId, where.streamName);
      if (workDir) {
        // A failed retry may not have reached preparation. Recover only this
        // hand's same-path attestation; prepareWorkDir rechecks its identity.
        const sameDir = prior ? registry.all().filter(e => e.tmuxSession === prior.tmuxSession && e.workDir === workDir) : [];
        const prepared = [...sameDir].reverse().find(e => e.workDirReady && (e.workDirIdentity || e.workDirAdoption));
        const trust = engine === 'claude';
        if (prepared?.workDirIdentity) {
          registry.update(entry, { workDirReady: true, workDirIdentity: await prepareWorkDir(this.d.host, cfg, workDir, { kind: 'attest', identity: prepared.workDirIdentity }, trust) });
        } else if (prepared?.workDirAdoption) {
          registry.update(entry, { workDirReady: true, workDirAdoption: await prepareWorkDir(this.d.host, cfg, workDir, { kind: 'attest', identity: prepared.workDirAdoption }, trust) });
        } else if (prior && sameDir.some(e => e.workDirReady === true) && !sameDir.some(e => e.workDirIdentity || e.workDirAdoption)) {
          // Pre-attestation hand: its own history prepared exactly this path.
          // Adopt it under new-hand safety checks. The adoption identity is
          // kept apart from workDirIdentity: it guards later revivals against
          // a swapped folder but never authorizes ordinary recursive delete.
          const references = this.otherHandPaths(prior.tmuxSession);
          const workRoot = resolve(cfg.workRoot ?? resolve(cfg.projectDir, 'hands'));
          if (/[\/]/.test(prior.tmuxSession) || workDir !== resolve(workRoot, prior.tmuxSession)) {
            throw new Error(`Workspace already exists: ${workDir}. Refusing to adopt it: a pre-attestation workspace is adopted only at <workRoot>/${prior.tmuxSession}.`);
          }
          if (references.some(r => resolve(r) === workDir || resolve(r).startsWith(workDir + '/') || workDir.startsWith(resolve(r) + '/'))) {
            throw new Error(`Workspace already exists: ${workDir}. Refusing to adopt it: directory shared with another hand.`);
          }
          const workDirAdoption = await prepareWorkDir(this.d.host, cfg, workDir, { kind: 'adopt-legacy', name: prior.tmuxSession, references }, trust);
          if (!workDirAdoption?.nonce) throw new Error(`Workspace already exists: ${workDir}. Refusing to adopt it: adoption was not attested.`);
          log(`${personaName}: adopted pre-attestation workspace ${JSON.stringify(workDir)} (continuity only; not a creation attestation)`);
          registry.update(entry, { workDirReady: true, workDirAdoption });
        } else {
          registry.update(entry, { workDirReady: true, workDirIdentity: await prepareWorkDir(this.d.host, cfg, workDir, prior?.workDirReady ? { kind: 'attest' } : { kind: 'fresh' }, trust) });
        }
      }

      const seedCtx = { personaName, streamName: where.streamName, topic: where.topic, realm: this.d.realm };
      let seed = canResume
        ? buildResumePrompt({ ...seedCtx, awaySince: prior?.endReason ? `(${prior.endReason})` : undefined })
        : buildSeedPrompt(seedCtx);
      if (engine === 'codex') {
        if (!this.d.codexBoundary) throw new Error('Codex catch-up boundary unavailable');
        const boundary = await this.d.codexBoundary({ ...entry, ...destination });
        if (!Number.isSafeInteger(boundary) || boundary < 0) throw new Error('Invalid Codex catch-up boundary');
        codexCatchupThrough = boundary;
        seed = buildCodexPrompt(seedCtx, boundary, canResume);
      }
      if (prior) {
        for (const path of [paths.filters, paths.bridgeConfig, paths.seed]) {
          savedFiles.set(path, await this.d.host.exists(path) ? await this.d.host.readFrom(path, 0) : undefined);
        }
      }
      filesTouched = true;
      await this.d.host.mkdirp(cfg.handsDir);
      // New folders are attested privately and published with no-replace rename.
      const { stdout: handDirCreated } = await this.d.host.exec(cfg.nodeBin, ['-e',
        PREPARE_HANDDIR_JS,
        paths.dir, JSON.stringify(prior?.handDirReady ? prior.handDirIdentity ?? null : null)]);
      await writeHandFiles(this.d.host, cfg, shortName, where.streamName, this.d.provisioner.credsFor(bot), seed, prior?.handDir, workDir);

      const handDirIdentity = handDirCreated.trim() ? JSON.parse(handDirCreated) ?? undefined : undefined;
      registry.update(entry, { handDirReady: Boolean(handDirIdentity), handDirIdentity });

      const startOffset = canResume && engine !== 'codex' ? (await this.d.host.size(this.d.watcher.transcriptPath(sessionId, workDir))) ?? 0 : 0;
      launched = true;
      const launcher = engine === 'codex' ? new CodexLauncher(cfg, tmux, this.d.host) : this.d.launcher;
      const result: { warning?: string; sessionId?: string } = await launcher.launch({
        personaName,
        workDir,
        model: cmd.model,
        effort,
        sessionId,
        resume: canResume,
        tmuxSession: shortName,
        bridgeConfig: paths.bridgeConfig,
        seedFile: paths.seed,
        spawnedBy: inv.invoker.name,
        streamName: where.streamName,
        topic: where.topic,
      });
      launchSucceeded = true;
      registry.update(entry, { codexCatchupThrough, ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}), ...destination, status: 'alive', transcriptOffset: startOffset, lastActivity: new Date().toISOString() });

      let modelWarning = '';
      if (!result.warning) {
        registry.update(entry, { model: cmd.model, effort });
        if (prior && (modelChange || prior.effort !== effort)) modelWarning = await this.renameModel(entry);
      } else if (modelChange || prior && prior.effort !== effort) {
        modelWarning = '\n⚠️ Model/effort switch not confirmed; registry model/effort and bot display name kept. Inspect with `peek`.';
      }
      this.d.codexWake?.ready(entry);

      const label = modelLabel(entry);
      const note = (result.warning ? `\n⚠️ ${result.warning}` : '') + modelWarning;
      if (canResume) {
        return `Revived **${entry.personaName}** (${label}) in tmux \`${shortName}\` — same identity **and** same conversation; it is catching up on ${home(entry)}.${note}`;
      }
      const amnesia = lostContext ? `\n⚠️ Its previous conversation is unavailable, so it starts fresh — same Zulip identity, no memory of before.` : '';
      return `Spawned @**${entry.personaName}** (${label}) in tmux \`${shortName}\`, home ${home(entry)} — it should introduce itself shortly.${amnesia}${note}`;
    } catch (err) {
      console.error(err);
      let rollbackWarning = '';
      if (filesTouched && prior && !launchSucceeded) {
        for (const [path, content] of savedFiles) {
          try {
            if (content === undefined) await this.d.host.exec('rm', ['-f', '--', path]);
            else await this.d.host.writeFile(path, content.toString('utf8'), 0o600);
          } catch (restoreErr) {
            log(`restore ${path}: ${(restoreErr as Error).message}`);
            rollbackWarning = '\n⚠️ Could not restore all home files; ask an operator to inspect before retrying.';
          }
        }
      }
      const message = engine === 'codex' ? (/^Codex (needs login|startup timed out|exited during startup)/.test((err as Error).message) ? (err as Error).message : 'Codex launch failed; ask an operator to inspect the logs.') : (err as Error).message;
      log(`spawn of ${personaName} failed: ${message}`);
      const kept = entry.botUserId ? ` Its Zulip bot (${entry.botEmail}) is kept, so a retry reuses it.` : '';
      if (launched) {
        try {
          await tmux.killSession(shortName);
        } catch (killErr) {
          // Never mark a possibly-running session as failed: it would drop out
          // of capacity and sweeps. The reaper retries the kill.
          log(`cleanup kill ${shortName}: ${(killErr as Error).message}`);
          registry.update(entry, { status: 'cleanup', endReason: `spawn failed: ${message}` });
          this.d.codexWake?.ready(entry);
          return `Spawn of **${personaName}** failed: ${message}\n⚠️ Its tmux session could not be confirmed stopped; I'll keep retrying. The name stays taken until then.${rollbackWarning}`;
        }
      }
      registry.update(entry, { status: 'failed', endReason: `spawn failed: ${message}` });
      this.d.codexWake?.ready(entry);
      return `Spawn of **${personaName}** failed: ${message}${kept}${rollbackWarning}`;
    }
  }

  /** Recorded paths of every OTHER hand identity (deduplicated). */
  private otherHandPaths(tmuxSession: string): string[] {
    return [...new Set(this.d.registry.all().filter(e => e.tmuxSession !== tmuxSession)
      .flatMap(e => [e.handDir, ...(e.workDir ? [e.workDir] : []), ...(e.seedFile?.startsWith('/') ? [e.seedFile] : [])]))];
  }

  private owns(inv: Invocation, entry: BotEntry): boolean {
    return inv.invoker.userId === entry.spawnedBy?.userId || inv.invoker.userId === this.d.config.ownerUserId;
  }

  /** Adopted hands with no creator and no configured owner retain collaborative
   * controls even in strict mode, including rename/model changes. */
  private canControl(inv: Invocation, entry: BotEntry): boolean {
    return !this.d.config.creatorOnlyControls || this.owns(inv, entry) ||
      (!entry.spawnedBy && this.d.config.ownerUserId == null);
  }

  private ownerDescription(): string {
    const owner = this.d.config.ownerUserId;
    return owner == null ? 'the owner (not configured)' : `the owner (user ${owner})`;
  }

  private ownerRefusal(entry: BotEntry): string {
    return `Only this hand's creator (user ${entry.spawnedBy?.userId ?? 'unknown'}) or ${this.ownerDescription()} may rename it, rehome or change its model, send raw keys, or answer permission prompts when creatorOnlyControls is enabled.`;
  }

  private async rename(inv: Invocation, target: string, friendly: string): Promise<string> {
    const { registry } = this.d;
    const matches = registry.matchingHands(target);
    if (!matches.length) return `No hand matches \`${target}\` — try \`list\`.`;
    if (matches.length !== 1) return 'Ambiguous hand name — use a target shown by `list` or `list stopped`; nothing was changed.';
    const entry = matches[0];
    if (!this.canControl(inv, entry)) return this.ownerRefusal(entry);
    if (entry.status === 'provisioning') return 'Cannot rename a hand while it is provisioning — try again after startup.';
    if (!entry.botUserId) return 'Cannot rename a hand without a provisioned Zulip bot.';
    let fullName: string;
    try {
      // Keep the existing label (including effort); only the friendly part changes.
      handName(entry.model, friendly, entry.harness ?? (entry.engine === 'codex' ? 'cx' : 'cc'), entry.effort);
      fullName = entry.personaName.startsWith('[')
        ? entry.personaName.replace(/^(\[[^\]]+\] ).+$/, `$1${friendly}`)
        : modelDisplayName({ ...entry, friendlyName: friendly }, entry.model);
      if (fullName.length > 49) return 'Hand name too long — Zulip persona must be at most 49 characters.';
    } catch (err) {
      if ((err as Error).message === 'bad hand effort') return `Stored effort \`${entry.effort}\` is not recognized — correct it before renaming; nothing was changed.`;
      return 'Invalid hand name — use 1-24 chars of [A-Za-z0-9-]; Zulip persona must be at most 49 characters.';
    }
    const oldName = entry.personaName;
    const oldFriendly = entry.friendlyName ?? oldName.match(/^\[[^\]]+\] (.+)$/)?.[1] ?? entry.suffix;
    const aliases = [...new Set([...(entry.nameAliases ?? []), entry.suffix, oldFriendly, oldName])];
    if (registry.nameCollision({ ...entry, personaName: fullName, friendlyName: friendly, nameAliases: aliases })) return `Name collision: the resulting names for \`${friendly}\` overlap another hand's names or aliases.`;
    try {
      await this.d.provisioner.rename(entry.botUserId, fullName);
    } catch (err) {
      log(`rename ${entry.tmuxSession}: ${(err as Error).message}`);
      return 'Could not rename the Zulip bot; registry name and aliases unchanged. Try again.';
    }
    registry.update(entry, { personaName: fullName, friendlyName: friendly, nameAliases: aliases, nameScheme: entry.nameScheme ?? 'bracket-v1' });
    return `Renamed **${oldName}** to **${fullName}**. Old names remain aliases; same bot, session, workdir and conversation.`;
  }

  /** Model truth is committed before the cosmetic rename. A PATCH failure must
   * never roll back a successful session switch or lose the existing bot. */
  private async renameModel(entry: BotEntry): Promise<string> {
    try {
      const fullName = modelDisplayName(entry, entry.model);
      await this.d.provisioner.rename(entry.botUserId, fullName);
      this.d.registry.update(entry, {
        nameAliases: [...new Set([...(entry.nameAliases ?? []), entry.personaName])],
        personaName: fullName, nameScheme: entry.nameScheme ?? 'bracket-v1',
      });
      return '';
    } catch (err) {
      log(`rename ${entry.tmuxSession}: ${(err as Error).message}`);
      return '\n⚠️ Model/effort confirmed, but the bot display-name update failed; its email and session are unchanged.';
    }
  }

  private async model(inv: Invocation, cmd: Command & { kind: 'model' }): Promise<string> {
    const entry = this.d.registry.findAlive(cmd.target);
    if (!entry) return `No running hand matches \`${cmd.target}\` — try \`list\`.`;
    return this.modelEntry(inv, entry, cmd);
  }

  private async modelEntry(inv: Invocation, entry: BotEntry, cmd: { model?: string; effort?: string }): Promise<string> {
    if (!this.canControl(inv, entry)) return this.ownerRefusal(entry);
    const engine = entry.engine ?? inferEngine(entry.model);
    if (cmd.model && inferEngine(cmd.model) !== engine) return 'Cannot change engine: Claude and Codex sessions are incompatible; spawn a new hand instead.';
    if (entry.pendingQuestion) return 'Answer or dismiss the pending question before changing model.';
    if (cmd.effort && cmd.model) {
      const error = effortError(cmd.effort, cmd.model, engine);
      if (error) return error;
    }
    this.d.registry.update(entry, { pendingModelMenu: undefined });
    try {
      const result = await (this.d.modelSwitcher ?? new LiveModelSwitcher(this.d.tmux)).run(entry.tmuxSession, engine, cmd.model, cmd.effort);
      if (result.kind === 'menu') {
        const options = result.menu.options.filter(o => result.menu.kind === 'models' && !/More|default|custom/i.test(o.label));
        if (!options.length) return 'No selectable model list found; menu cancelled, old model kept.';
        this.d.registry.update(entry, { pendingModelMenu: { options, effort: cmd.effort, postedAt: new Date().toISOString() } });
        await this.d.notifier.postHome(entry, [
          `Model menu for **${entry.personaName}** (current: \`${entry.model}\`). ${cmd.model ? 'Requested model not on screen. ' : ''}Menu closed while waiting.`,
          ...options.map(o => `${o.number}. ${o.label}`),
          result.menu.more ? '↓ More entries exist below the visible list; no off-screen choice was guessed.' : '',
          `${this.d.config.creatorOnlyControls && (entry.spawnedBy || this.d.config.ownerUserId != null) ? 'Creator/owner' : 'Any allowed caller'}: mention the spawner with \`answer ${this.d.registry.commandTarget(entry)} <number>\` (or a bare number here) within 5 minutes. \`esc\` cancels.`,
        ].filter(Boolean).join('\n'));
        return `Model menu posted to ${home(entry)}; no switch yet.`;
      }
      this.d.registry.update(entry, { model: result.model, effort: engine === 'codex' ? result.effort : entry.effort });
      const warning = await this.renameModel(entry);
      return `Changed **${entry.personaName}** to \`${modelLabel(entry)}\` without stopping; same session and workdir.${warning}`;
    } catch (err) {
      return `Could not change **${entry.personaName}**'s model: ${(err as Error).message}. No model/name update recorded.`;
    }
  }

  private async answerModel(inv: Invocation, entry: BotEntry, spec: string): Promise<string> {
    const pending = entry.pendingModelMenu!;
    // Expiry is housekeeping, not privileged terminal control. Any authorized
    // caller can retire an expired snapshot without touching the terminal.
    if (Date.now() - Date.parse(pending.postedAt) > 5 * 60_000) {
      this.d.registry.update(entry, { pendingModelMenu: undefined });
      return 'Model menu snapshot expired; run `model <hand>` again.';
    }
    if (!this.canControl(inv, entry)) return this.ownerRefusal(entry);
    if (/^(esc|escape|cancel)$/i.test(spec.trim())) {
      this.d.registry.update(entry, { pendingModelMenu: undefined });
      return 'Model choice cancelled (terminal menu already closed).';
    }
    const option = /^\d+$/.test(spec.trim()) ? pending.options.find(o => o.number === Number(spec.trim())) : undefined;
    if (!option) return 'Answer with one of the posted model numbers, or `esc`.';
    return this.modelEntry(inv, entry, { model: option.model, effort: pending.effort });
  }

  private list(): string {
    const alive = this.d.registry.alive();
    if (alive.length === 0) return 'No hands running.';
    const now = Date.now();
    const rows = alive.map(e => [
      listIdentity(e, this.d.registry), listText(modelLabel(e)), listHome(e),
      listActivity(e.lastActivity, now) + (e.pendingQuestion ? ' · ⏸ blocked on a dialog' : ''),
      listText(String(e.spawnedBy?.username || e.spawnedBy?.userId || 'unknown')),
    ]);
    return `${alive.length}/${this.d.config.maxSessions} hands:\n` + listTable(false, rows);
  }

  private async listStopped(bySize = false, creator?: number | 'unknown'): Promise<string> {
    const stopped: BotEntry[] = [];
    const failures: string[] = [];
    for (const entry of this.d.registry.currentHands()) {
      if (creator !== undefined && (creator === 'unknown' ? entry.spawnedBy !== undefined : entry.spawnedBy?.userId !== creator)) continue;
      const history = this.d.registry.all().filter(e => e.tmuxSession === entry.tmuxSession);
      try {
        if (await handStopped(this.d.host, this.d.tmux, this.d.config, history)) stopped.push(entry);
      } catch (err) {
        const cause = err instanceof ProcessLivenessError ? err.message : 'liveness check failed';
        log(`list stopped liveness ${entry.tmuxSession}: ${JSON.stringify(cause)}`);
        failures.push(`* Could not verify stopped hand ${listIdentity(entry, this.d.registry)}: ${listText(cause)}`);
      }
    }
    if (!stopped.length) return [failures.length ? 'No verified stopped hands.' : 'No stopped hands.', ...failures].join('\n');
    const sizes = await workdirSizes(this.d.host, this.d.config, stopped.map(e => e.workDir ?? this.d.config.projectDir));
    const sizeMap = new Map(stopped.map((e, i) => [e, sizes[i]]));
    if (bySize) stopped.sort((a, b) => sizeMap.get(b)!.bytes - sizeMap.get(a)!.bytes);
    const now = Date.now();
    const rows = stopped.map(e => [
      listIdentity(e, this.d.registry), listText(modelLabel(e)), listHome(e),
      formatWorkdirSize(sizeMap.get(e)!) + (!e.workDir ? ' (shared projectDir)' : ''),
      listActivity(e.lastActivity, now),
      listText(String(e.spawnedBy?.username || e.spawnedBy?.userId || 'unknown')),
    ]);
    return `${stopped.length} stopped hand(s):\n` + listTable(true, rows) + failures.join('\n');
  }

  private async deleteHand(inv: Invocation, target: string, confirm = false, forceLegacy = false, legacyToken?: string): Promise<string> {
    const { registry, config: cfg, host, tmux } = this.d;
    const matches = registry.matchingHands(target);
    if (!matches.length) return `Hand \`${target}\` not found.`;
    if (matches.length !== 1) return 'Ambiguous hand name — use a target shown by `list` or `list stopped`; nothing was changed.';
    const entry = matches[0];
    const admins = cfg.adminUserIds ?? (cfg.ownerUserId == null ? [] : [cfg.ownerUserId]);
    if (forceLegacy && !admins.includes(inv.invoker.userId)) {
      return admins.length ? 'Only configured force-legacy admins may use force-legacy.' : 'force-legacy is disabled: no admins configured.';
    }
    if (!forceLegacy && !this.owns(inv, entry)) {
      if (!entry.spawnedBy && cfg.ownerUserId == null) return 'Cannot delete this hand: creator unknown and no ownerUserId configured; nothing was changed.';
      return `Only this hand's creator (user ${entry.spawnedBy?.userId ?? 'unknown'}) or ${this.ownerDescription()} may delete it, regardless of creatorOnlyControls.`;
    }
    const history = registry.all().filter(e => e.tmuxSession === entry.tmuxSession);
    if (forceLegacy && history.some(e => e.handDirIdentity || e.workDirIdentity)) return 'force-legacy is only for pre-attestation hands; use ordinary delete.';
    const references = this.otherHandPaths(entry.tmuxSession);
    // Implicit legacy cwd is a protected root, not an exclusive subtree.
    // deletionPaths already protects projectDir itself and its ancestors.
    const plan: DeletionPath[] = [];
    for (const e of history) {
      for (const p of [
        { kind: 'hand dir' as const, path: e.handDir, root: cfg.handsDir },
        ...(e.workDir ? [{ kind: 'workDir' as const, path: e.workDir, root: cfg.workRoot ?? resolve(cfg.projectDir, 'hands') }] : []),
      ]) {
        if (!plan.some(x => x.kind === p.kind && x.path === p.path)) plan.push(p);
      }
    }
    const rawPreview = [
      ...plan.map(p => `* ${p.kind}: ${JSON.stringify(p.path)}`),
      ...history.filter(e => !e.workDir).map(() => `* workDir: ${JSON.stringify(cfg.projectDir)} (kept: legacy shared projectDir)`),
      `* Bot ids: ${[...new Set(history.map(e => e.botUserId))].join(', ')}`,
    ].join('\n');
    if (forceLegacy && plan.some(p => !entry.tmuxSession || /[\/]/.test(entry.tmuxSession) ||
      p.path !== resolve(p.root, entry.tmuxSession))) {
      return `Force-legacy refused: path outside the hand's named subtree; nothing changed.
${rawPreview}`;
    }
    // Only this hand's positive, path-specific creation attestations qualify.
    for (const p of plan) {
      p.identities = history.flatMap(e => {
        const identity = p.kind === 'hand dir' ? e.handDirIdentity : e.workDirIdentity;
        const ready = p.kind === 'hand dir' ? e.handDirReady : e.workDirReady;
        return ready && identity && (p.kind === 'hand dir' ? e.handDir : e.workDir) === p.path ? [identity] : [];
      });
      p.recursive = forceLegacy || p.identities.length > 0;
      p.legacy = forceLegacy;
    }
    // A proven historical parent must not recursively swallow an unproven
    // child (or another spelling/kind of the same path), even if it gains data.
    const unproven = plan.filter(p => !p.recursive);
    for (const p of plan) {
      if (unproven.some(child => resolve(child.path) === resolve(p.path) ||
        resolve(child.path).startsWith(resolve(p.path) + '/'))) p.recursive = false;
    }
    // Do not remove a path still referenced by another identity.
    if (registry.all().some(e => e.tmuxSession !== entry.tmuxSession && plan.some(p =>
      [e.handDir, e.workDir].some(dir => dir && (resolve(dir) === resolve(p.path) || resolve(dir).startsWith(resolve(p.path) + '/') || resolve(p.path).startsWith(resolve(dir) + '/')))))) {
      return `Cannot delete: a directory is shared with another hand; nothing was changed.
${rawPreview}`;
    }
    try {
      const checked = await deletionPaths(host, cfg, plan, false, references);
      if (checked.error) return `Cannot delete: ${checked.error}; nothing was changed.
${rawPreview}`;
      if (!(await handStopped(host, tmux, cfg, history))) return 'Cannot delete: hand must be STOPPED (no live tmux session or running process); nothing was changed.';
      const bots = [...new Set(history.filter(e => (forceLegacy || e.botCreatedBySpawner === true) && Number.isSafeInteger(e.botUserId) && e.botUserId > 0).map(e => e.botUserId))];
      // Never deactivate an identity referenced by another hand.
      if (registry.all().some(e => e.tmuxSession !== entry.tmuxSession && bots.includes(e.botUserId))) {
        return `Cannot delete: a bot is shared with another hand; nothing was changed.
${rawPreview}`;
      }
      const previewFor = (paths: CheckedDeletionPath[]) => [
        `* Registry: all ${history.length} entry/entries for tmux \`${entry.tmuxSession}\`.`,
        ...paths.map(p => `* ${p.kind}: ${JSON.stringify(p.path)}${p.exists ? p.kept ? ' (kept: not created by this hand)' : p.recursive ? ' (remove directory and contents)' : ' (remove empty directory only)' : ' (already absent; nothing to remove)'}.`),
        ...(!history.every(e => e.workDir) ? [`* workDir: ${JSON.stringify(cfg.projectDir)} (not recorded; legacy projectDir is kept).`] : []),
        bots.length ? `* Bot deactivation: ${bots.map(id => `user ${id}`).join(', ')} (${forceLegacy ? 'explicit legacy override' : 'recorded as spawner-created'}).` : '* Bot deactivation: none (no recorded spawner-created bot; existing bot kept).',
      ].join('\n');
      const preview = previewFor(checked.paths!);
      if (forceLegacy) {
        const key = `${inv.invoker.userId}:${entry.tmuxSession}`;
        const signature = JSON.stringify([history, [...new Set(references)].sort(),
          [...new Set(registry.all().filter(e => e.tmuxSession !== entry.tmuxSession).map(e => e.botUserId))].sort((a, b) => a - b),
          cfg.projectDir, cfg.handsDir, cfg.workRoot, admins, checked.paths, bots]);
        const pending = this.legacyDeletes.get(key);
        this.legacyDeletes.delete(key);
        if (!legacyToken || !pending || pending.token !== legacyToken ||
            pending.expires < Date.now() || pending.signature !== signature) {
          const token = randomBytes(12).toString('hex');
          this.legacyDeletes.set(key, { token, signature, expires: Date.now() + 5 * 60_000 });
          return `Force-legacy preview (no ownership attestation created):
${preview}
Nothing changed. Confirm within 5 minutes with \`delete ${registry.commandTarget(entry)} confirm force-legacy ${token}\`.`;
        }
      }
      if (!confirm) return `Dry-run for **${entry.personaName}** — would remove:\n${preview}\nNothing changed. Run \`delete ${this.d.registry.commandTarget(entry)} confirm\` to proceed.`;

      // Revalidate immediately before deletion; keep the registry on filesystem
      // failure so a partial cleanup can be retried. Bot failure is non-fatal.
      if (!(await handStopped(host, tmux, cfg, history))) return 'Cannot delete: hand is no longer stopped; nothing was changed.';
      const cleanup = await deletionPaths(host, cfg, forceLegacy ? checked.paths! : plan, true, references);
      for (const path of cleanup.removed) log(`delete ${entry.tmuxSession}: removed directory ${JSON.stringify(path)}`);
      if (cleanup.error) return `Deletion incomplete: ${cleanup.error}. Registry kept for retry; ${cleanup.removed.length} directory/directories removed.`;
      for (const p of cleanup.paths!.filter(p => !p.exists)) log(`delete ${entry.tmuxSession}: directory already absent ${JSON.stringify(p.path)}`);
      const warnings: string[] = [];
      for (const botId of bots) {
        try {
          await this.d.provisioner.deactivate(botId);
          log(`delete ${entry.tmuxSession}: deactivated bot ${botId}`);
        } catch {
          log(`delete ${entry.tmuxSession}: bot ${botId} deactivation failed; continuing local cleanup`);
          warnings.push(`⚠️ Bot ${botId} deactivation failed; local cleanup still completed. Ask the owner to deactivate it manually.`);
        }
      }
      if (!bots.length) log(`delete ${entry.tmuxSession}: kept bot (no recorded creation provenance)`);
      const count = registry.removeHand(entry.tmuxSession);
      log(`delete ${entry.tmuxSession}: removed ${count} registry entries`);
      return `Deleted **${entry.personaName}**.\n${previewFor(cleanup.paths!)}${warnings.length ? '\n' + warnings.join('\n') : ''}`;
    } catch (err) {
      log(`delete ${entry.tmuxSession}: failed ${err instanceof ProcessLivenessError ? JSON.stringify(err.message) : 'path, liveness or registry check failed'}`);
      if (err instanceof ProcessLivenessError) return `Could not complete deletion: ${err.message}. Registry kept for retry.`;
      return 'Could not complete deletion (path, liveness or registry check failed). Registry kept for retry; inspect logs before retrying.';
    }
  }

  private async stop(inv: Invocation, target: string): Promise<string> {
    const entry = this.d.registry.findAlive(target);
    if (!entry) return `No running hand matches \`${target}\` — try \`list\`.`;
    try {
      await this.d.tmux.killSession(entry.tmuxSession);
    } catch (err) {
      return `Could not stop **${entry.personaName}**: ${(err as Error).message} — it is still registered as running.`;
    }
    this.d.registry.update(entry, { status: 'reaped', endReason: `stopped by ${inv.invoker.name} (${inv.invoker.userId})` });
    return `Stopped **${entry.personaName}**. Identity and conversation kept — \`spawn ${entry.model} name=${this.d.registry.commandTarget(entry)}\` revives it.`;
  }

  /** Private by default; explicit here uses the ordinary invocation reply route. */
  private async peek(target: string, wantLines?: number, here = false): Promise<ActionResult> {
    const entry = this.d.registry.findAlive(target);
    if (!entry) return { content: `No running hand matches \`${target}\` — try \`list\`.`, private: !here };
    const tmux = this.d.tmux;
    if (!(await tmux.hasSession(entry.tmuxSession))) {
      return { content: `**${entry.personaName}**'s tmux session is gone — it'll be marked reaped on the next sweep.`, private: !here };
    }
    const want = wantLines ?? PEEK_DEFAULT_LINES;
    const pane = await tmux.capturePane(entry.tmuxSession, want > 30 ? want + 50 : 0);
    const uptime = await tmux.sessionUptime(entry.tmuxSession);
    const idleMin = Math.round((Date.now() - Date.parse(entry.lastActivity)) / 60_000);
    const lines = pane.replace(/\s+$/, '').split('\n').filter((l) => l.trim());
    let tail = lines.slice(-want).join('\n');
    let note = '';
    if (tail.length > PEEK_INLINE_BUDGET) {
      tail = tail.slice(-PEEK_INLINE_BUDGET);
      note = `\n_showing the last ${tail.split('\n').length} lines — more did not fit one message._`;
    }
    const header = [
      `**${entry.personaName}** (${modelLabel(entry)}) — tmux \`${entry.tmuxSession}\`, home ${home(entry)}`,
      `up ${uptime === undefined ? '?' : formatDuration(uptime)} · last public activity ${formatIdle(idleMin)} ago · spawned by ${entry.spawnedBy?.username ?? 'unknown'}`,
    ].join('\n');
    return { private: !here, content: `${header}\n\`\`\`text\n${tail.replace(/```/g, "'''")}\n\`\`\`${note}` };
  }

  /** Deliver an answer into a blocked dialog. Pending state is cleared by the
   *  watcher when the resolution is observed (ground truth). */
  private async answer(inv: Invocation, target: string, spec: string): Promise<string> {
    const entry = this.d.registry.findAlive(target);
    if (!entry) return `No running hand matches \`${target}\` — try \`list\`.`;
    const pending = entry.pendingQuestion;
    // A real terminal dialog supersedes the closed model-menu snapshot. Retire
    // that snapshot so it cannot consume this answer (or a later shortcut).
    // The normal permission ownership and current-pane checks still apply.
    if (entry.pendingModelMenu) {
      if (!pending) return this.answerModel(inv, entry, spec);
      this.d.registry.update(entry, { pendingModelMenu: undefined });
    }
    if (!pending) return `**${entry.personaName}** has no pending question I know of — \`rescan\` if you think it's stuck on one.`;
    // AskUserQuestion stays collaborative; permission prompts follow the
    // optional creator-only policy, just like raw terminal keys.
    if (pending.questions[0]?.kind === 'permission' && !this.canControl(inv, entry)) return this.ownerRefusal(entry);
    if (!pending.messageId) return `**${entry.personaName}**'s current dialog hasn't been posted yet — \`rescan\` to retry; no keys sent.`;
    const parsed = parseAnswerSpec(spec, pending.questions[0]);
    if (parsed.kind === 'error') return `Can't parse that answer: ${parsed.error}`;
    let warning: string | undefined;
    try {
      warning = await injectAnswer(this.d.tmux, entry.tmuxSession, pending, parsed, () => this.d.watcher.readDialog(entry));
    } catch (err) {
      if (err instanceof PartialAnswerError) {
        // Some keys are in the terminal: neither delivered nor withheld.
        const target = this.d.registry.commandTarget(entry);
        return `Only part of the answer reached **${entry.personaName}**: sent ${err.sent.map((k) => `\`${k}\``).join(' ')}, then tmux failed. ` +
          `The dialog may be half-answered — inspect with \`peek ${target}\` before trying again; \`press ${target} esc\` cancels it.`;
      }
      return `Could not deliver the answer to **${entry.personaName}**: ${(err as Error).message}`;
    }
    // The keys are out. Nothing below may turn that into "could not deliver":
    // whoever reads that sends the answer again, to whatever is on screen then.
    const what = parsed.kind === 'esc' ? 'Dismissal' : 'Answer';
    const note = warning ? `\nℹ️ ${warning}` : '';
    if (pending.questions[0].kind !== 'permission') return `${what} sent to **${entry.personaName}** — I'll confirm once its session registers it.${note}`;
    const label =
      parsed.kind === 'esc' ? 'Esc' : parsed.kind === 'digits' ? pending.questions[0].options[parsed.nums[0] - 1]?.label ?? String(parsed.nums[0]) : '?';
    const unrecorded = this.recordSent(entry, { ...pending, answeredWith: label });
    return `${what} sent to **${entry.personaName}** — **${label}**. This confirms the key was sent, not the outcome.${note}${unrecorded}`;
  }

  /** Note on the pending dialog what was sent to it. The note is bookkeeping
   *  for the resolution notice; failing to save it does not unsend anything,
   *  so it is reported as that and never thrown. */
  private recordSent(entry: BotEntry, pendingQuestion: NonNullable<BotEntry['pendingQuestion']>): string {
    try {
      this.d.registry.update(entry, { pendingQuestion });
      return '';
    } catch (err) {
      log(`${entry.tmuxSession}: keys sent, but recording them failed: ${(err as Error).stack ?? err}`);
      return `\n⚠️ It **was sent** — do not send it again. I could not save my record of it (${(err as Error).message}), so the notice when this prompt closes may not say what was sent.`;
    }
  }

  /** Raw keystrokes — the escape hatch for anything the dialog parser misses. */
  private async press(inv: Invocation, target: string, keys: string[]): Promise<string> {
    const entry = this.d.registry.findAlive(target);
    if (!entry) return `No running hand matches \`${target}\` — try \`list\`.`;
    if (!this.canControl(inv, entry)) return this.ownerRefusal(entry);
    const sent: string[] = [];
    for (const raw of keys) {
      const named = KEY_NAMES[raw.toLowerCase()];
      try {
        if (named) await this.d.tmux.sendKeys(entry.tmuxSession, named);
        else if (/^\d$/.test(raw)) await this.d.tmux.sendKeys(entry.tmuxSession, raw);
        else await this.d.tmux.sendText(entry.tmuxSession, raw);
      } catch (err) {
        log(`press ${this.d.registry.commandTarget(entry)} failed at key ${sent.length + 1}: ${(err as Error).stack ?? err}`);
        const prefix = sent.length ? sent.map((k) => `\`${k}\``).join(' ') : 'none confirmed';
        return `Could not send \`${raw}\` to **${entry.personaName}**: tmux rejected key ${sent.length + 1}.\n` +
          `Sent before failure: ${prefix}. The input may be half-typed (the failed send may also have reached the terminal). ` +
          `Inspect with \`peek ${this.d.registry.commandTarget(entry)}\`; try \`press ${this.d.registry.commandTarget(entry)} ctrl-u\` to clear the line or \`press ${this.d.registry.commandTarget(entry)} esc\` to cancel.`;
      }
      sent.push(named ?? raw);
      await new Promise((r) => setTimeout(r, 300));
    }
    const unrecorded = entry.pendingQuestion ? this.recordSent(entry, { ...entry.pendingQuestion, answeredWith: `keys ${sent.join(' ')}` }) : '';
    return `Sent ${sent.map((k) => `\`${k}\``).join(' ')} to **${entry.personaName}** — \`peek ${this.d.registry.commandTarget(entry)}\` to see what it did.${unrecorded}`;
  }

  private async rescan(): Promise<string> {
    const alive = this.d.registry.alive();
    if (alive.length === 0) return 'No hands running.';
    const lines = await this.d.watcher.rescanDialogs();
    return lines.length ? `Scanned ${alive.length} hand(s):\n${lines.join('\n')}` : `Scanned ${alive.length} hand(s) — no open dialogs.`;
  }

  /** A hand's own public activity, observed on the spawner's event queue. */
  noteActivity(botUserId: number, kind: 'message', timestamp: number): void;
  noteActivity(botUserId: number, kind: 'reaction'): void;
  noteActivity(botUserId: number, kind: 'message' | 'reaction', timestamp?: number): void {
    const entry = this.d.registry.byBotUserId(botUserId);
    if (!entry) return;
    let activityAt: number;
    if (kind === 'message') {
      // Zulip timestamps have second precision. Floor spawn time so a real
      // startup post in that same second counts (sub-second order is unknown).
      // Older launches' delayed posts must neither prove startup nor renew idle.
      const messageAt = timestamp === undefined ? undefined : timestamp * 1000;
      if (!isPlausibleMessageTime(messageAt) || messageAt < Math.floor(Date.parse(entry.spawnedAt) / 1000) * 1000) return;
      activityAt = messageAt;
    } else {
      // Reactions have no event timestamp: only credit receipt while alive,
      // never a provisioning revival that may be seeing old-launch traffic.
      if (entry.status !== 'alive') return;
      activityAt = Date.now();
    }
    const patch: Partial<BotEntry> = {};
    // Use event time, not receipt time; delayed/out-of-order posts cannot make
    // an idle hand look active now or move the activity watermark backwards.
    if (activityAt > Date.parse(entry.lastActivity)) patch.lastActivity = new Date(activityAt).toISOString();
    if (kind === 'message' && !entry.firstPostAt) patch.firstPostAt = new Date(activityAt).toISOString();
    if (Object.keys(patch).length) this.d.registry.update(entry, patch);
  }

  /** Is this user id one of our hands (any status)? */
  isHand(userId: number): boolean {
    return this.d.registry.all().some((e) => e.botUserId === userId);
  }

  private async freshSuffix(): Promise<string> {
    const sessions = await this.d.tmux.listSessions();
    for (let i = 0; i < 16; i++) {
      const s = randomBytes(2).toString('hex');
      if (!this.d.registry.all().some((e) => e.suffix.toLowerCase() === s) && !this.d.registry.renamedHands(s).length && !sessions.some((n) => n.endsWith(`-${s}`))) return s;
    }
    throw new Error('could not find a free suffix');
  }
}
