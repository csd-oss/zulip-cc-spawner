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
import { handName } from './names.js';
import { isAllowed, type GroupCheck, type Invoker, type Where } from './auth.js';
import {
  EFFORT_DEFAULT,
  PEEK_DEFAULT_LINES,
  USAGE,
  buildAnswerCommand,
  effortError,
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
import { injectAnswer, parseAnswerSpec } from './question.js';
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
    log(`command from ${inv.invoker.name} (${inv.invoker.userId}): ${JSON.stringify(cmd)}`);
    switch (cmd.kind) {
      case 'spawn':
        return { content: await this.spawn(inv, cmd) };
      case 'models':
        return { content: modelsListing() };
      case 'list':
        return { content: this.list() };
      case 'stop':
        return { content: await this.stop(inv, cmd.target) };
      case 'peek':
        return this.peek(cmd.target, cmd.lines);
      case 'answer':
        return { content: await this.answer(cmd.target, cmd.spec) };
      case 'press':
        return { content: await this.press(cmd.target, cmd.keys) };
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
      .filter((e) => e.pendingQuestion && e.streamId === streamId && e.topic.toLowerCase() === topic.toLowerCase());
    return blocked.length === 1 ? buildAnswerCommand(blocked[0].suffix, inv.body) : inv.cmd;
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
    const names = handName(cmd.model, cmd.friendly ?? suffix, engine === 'codex' ? 'cx' : 'cc');
    // Prefer an existing legacy identity for the same model/suffix. Never
    // reinterpret an unmarked bracket-name entry as a new-style identity.
    const legacy = engine === 'codex' ? undefined : registry.latestFor(`Claude-Code-${slug}-${suffix}`);
    const modern = registry.latestFor(names.personaName);
    if (modern && modern.nameScheme !== 'bracket-v1') return 'Name collision with a legacy persona — pick another name.';
    if (legacy && modern) return 'Ambiguous legacy/new identity — pick another name.';
    const prior = legacy ?? modern;
    const personaName = prior?.personaName ?? names.personaName;
    const shortName = prior?.tmuxSession ?? names.shortName;
    const workDir = prior ? prior.workDir : resolve(cfg.workRoot ?? resolve(cfg.projectDir, 'hands'), shortName);
    if (!prior && registry.all().some((e) => e.tmuxSession === shortName && e.personaName.toLowerCase() !== personaName.toLowerCase())) {
      return 'Name collision with an existing identity — pick another name.';
    }

    const clash = registry.busy(suffix);
    if (clash) {
      return `\`${suffix}\` is taken by **${clash.personaName}** (${clash.model}) — \`stop ${suffix}\` first, or spawn without a name for a fresh hand.`;
    }
    if (await tmux.hasSession(shortName)) {
      return `tmux session \`${shortName}\` already exists outside my registry — pick another name or clean it up.`;
    }

    if (prior && prior.streamId !== where.streamId) {
      return `**${personaName}** already exists with its home in #${prior.streamName} — revive it there, or pick another name here.`;
    }
    if (prior && prior.model !== cmd.model) {
      return `**${personaName}** ran on \`${prior.model}\`, not \`${cmd.model}\` — revive it with that exact model, or pick another name.`;
    }

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
      suffix,
      personaName,
      botUserId: 0,
      botEmail: '',
      tmuxSession: shortName,
      streamName: where.streamName,
      streamId: where.streamId,
      topic: where.topic,
      handDir: paths.dir,
      workDir,
      workDirReady: prior?.workDirReady,
      nameScheme: prior ? prior.nameScheme : 'bracket-v1',
      harness: engine === 'codex' ? 'cx' : prior ? prior.harness : 'cc',
      engine,
      model: cmd.model,
      effort,
      sessionId,
      spawnedBy: { userId: inv.invoker.userId, username: inv.invoker.name },
      spawnedAt: now,
      lastActivity: now,
      status: 'provisioning',
      seedFile: paths.seed,
    };
    registry.add(entry);

    let launched = false;
    try {
      const { bot, created } = await this.d.provisioner.ensure(personaName, shortName, !prior);
      registry.update(entry, { botUserId: bot.userId, botEmail: bot.email });
      if (!created && !prior) log(`${personaName}: reusing an existing bot ${bot.email} with no registry history`);
      await this.d.provisioner.subscribe(bot.userId, where.streamName);
      if (workDir) {
        await prepareWorkDir(this.d.host, cfg, workDir, !prior?.workDirReady, engine === 'claude');
        registry.update(entry, { workDirReady: true });
      }

      const seedCtx = { personaName, streamName: where.streamName, topic: where.topic, realm: this.d.realm };
      let seed = canResume
        ? buildResumePrompt({ ...seedCtx, awaySince: prior?.endReason ? `(${prior.endReason})` : undefined })
        : buildSeedPrompt(seedCtx);
      if (engine === 'codex') {
        if (!this.d.codexBoundary) throw new Error('Codex catch-up boundary unavailable');
        const boundary = await this.d.codexBoundary(entry);
        if (!Number.isSafeInteger(boundary) || boundary < 0) throw new Error('Invalid Codex catch-up boundary');
        registry.update(entry, { codexCatchupThrough: boundary });
        seed = buildCodexPrompt(seedCtx, boundary, canResume);
      }
      await writeHandFiles(this.d.host, cfg, shortName, where.streamName, this.d.provisioner.credsFor(bot), seed, prior?.handDir);

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
      registry.update(entry, { ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}), status: 'alive', transcriptOffset: startOffset, lastActivity: new Date().toISOString() });

      this.d.codexWake?.ready(entry);

      const label = modelLabel({ model: cmd.model, effort });
      const note = result.warning ? `\n⚠️ ${result.warning}` : '';
      if (canResume) {
        return `Revived **${personaName}** (${label}) in tmux \`${shortName}\` — same identity **and** same conversation; it is catching up on ${home(entry)}.${note}`;
      }
      const amnesia = lostContext ? `\n⚠️ Its previous conversation is unavailable, so it starts fresh — same Zulip identity, no memory of before.` : '';
      return `Spawned @**${personaName}** (${label}) in tmux \`${shortName}\`, home ${home(entry)} — it should introduce itself shortly.${amnesia}${note}`;
    } catch (err) {
      console.error(err);
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
          return `Spawn of **${personaName}** failed: ${message}\n⚠️ Its tmux session could not be confirmed stopped; I'll keep retrying. The name stays taken until then.`;
        }
      }
      registry.update(entry, { status: 'failed', endReason: `spawn failed: ${message}` });
      this.d.codexWake?.ready(entry);
      return `Spawn of **${personaName}** failed: ${message}${kept}`;
    }
  }

  private list(): string {
    const alive = this.d.registry.alive();
    if (alive.length === 0) return 'No hands running.';
    const lines = alive.map((e) => {
      const idleMin = Math.round((Date.now() - Date.parse(e.lastActivity)) / 60_000);
      const blocked = e.pendingQuestion ? ' · ⏸ blocked on a dialog' : '';
      return `* **${e.personaName}** (${modelLabel(e)}) — ${home(e)}, tmux \`${e.tmuxSession}\`, idle ${formatIdle(idleMin)}${blocked}`;
    });
    return `${alive.length}/${this.d.config.maxSessions} hands:\n${lines.join('\n')}`;
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
    return `Stopped **${entry.personaName}**. Identity and conversation kept — \`spawn ${entry.model} name=${entry.suffix}\` revives it.`;
  }

  /** The terminal tail, always delivered by DM (it may show anything the hand typed). */
  private async peek(target: string, wantLines?: number): Promise<ActionResult> {
    const entry = this.d.registry.findAlive(target);
    if (!entry) return { content: `No running hand matches \`${target}\` — try \`list\`.`, private: true };
    const tmux = this.d.tmux;
    if (!(await tmux.hasSession(entry.tmuxSession))) {
      return { content: `**${entry.personaName}**'s tmux session is gone — it'll be marked reaped on the next sweep.`, private: true };
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
      `up ${uptime === undefined ? '?' : formatDuration(uptime)} · last public activity ${formatIdle(idleMin)} ago · spawned by ${entry.spawnedBy.username}`,
    ].join('\n');
    return { private: true, content: `${header}\n\`\`\`text\n${tail.replace(/```/g, "'''")}\n\`\`\`${note}` };
  }

  /** Deliver an answer into a blocked dialog. Pending state is cleared by the
   *  watcher when the resolution is observed (ground truth). */
  private async answer(target: string, spec: string): Promise<string> {
    const entry = this.d.registry.findAlive(target);
    if (!entry) return `No running hand matches \`${target}\` — try \`list\`.`;
    const pending = entry.pendingQuestion;
    if (!pending) return `**${entry.personaName}** has no pending question I know of — \`rescan\` if you think it's stuck on one.`;
    const parsed = parseAnswerSpec(spec, pending.questions[0]);
    if (parsed.kind === 'error') return `Can't parse that answer: ${parsed.error}`;
    try {
      const warning = await injectAnswer(this.d.tmux, entry.tmuxSession, pending, parsed);
      if (pending.questions[0].kind === 'permission') {
        const label =
          parsed.kind === 'esc' ? 'Esc' : parsed.kind === 'digits' ? pending.questions[0].options[parsed.nums[0] - 1]?.label ?? String(parsed.nums[0]) : '?';
        this.d.registry.update(entry, { pendingQuestion: { ...pending, answeredWith: label } });
      }
      const what = parsed.kind === 'esc' ? 'Dismissal' : 'Answer';
      return `${what} sent to **${entry.personaName}** — I'll confirm once its session registers it.${warning ? `\nℹ️ ${warning}` : ''}`;
    } catch (err) {
      return `Could not deliver the answer to **${entry.personaName}**: ${(err as Error).message}`;
    }
  }

  /** Raw keystrokes — the escape hatch for anything the dialog parser misses. */
  private async press(target: string, keys: string[]): Promise<string> {
    const entry = this.d.registry.findAlive(target);
    if (!entry) return `No running hand matches \`${target}\` — try \`list\`.`;
    const sent: string[] = [];
    for (const raw of keys) {
      const named = KEY_NAMES[raw.toLowerCase()];
      try {
        if (named) await this.d.tmux.sendKeys(entry.tmuxSession, named);
        else if (/^\d$/.test(raw)) await this.d.tmux.sendKeys(entry.tmuxSession, raw);
        else await this.d.tmux.sendText(entry.tmuxSession, raw);
      } catch (err) {
        log(`press ${entry.suffix} failed at key ${sent.length + 1}: ${(err as Error).stack ?? err}`);
        const prefix = sent.length ? sent.map((k) => `\`${k}\``).join(' ') : 'none confirmed';
        return `Could not send \`${raw}\` to **${entry.personaName}**: tmux rejected key ${sent.length + 1}.\n` +
          `Sent before failure: ${prefix}. The input may be half-typed (the failed send may also have reached the terminal). ` +
          `Inspect with \`peek ${entry.suffix}\`; try \`press ${entry.suffix} ctrl-u\` to clear the line or \`press ${entry.suffix} esc\` to cancel.`;
      }
      sent.push(named ?? raw);
      await new Promise((r) => setTimeout(r, 300));
    }
    if (entry.pendingQuestion) {
      this.d.registry.update(entry, { pendingQuestion: { ...entry.pendingQuestion, answeredWith: `keys ${sent.join(' ')}` } });
    }
    return `Sent ${sent.map((k) => `\`${k}\``).join(' ')} to **${entry.personaName}** — \`peek ${entry.suffix}\` to see what it did.`;
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
      if (!this.d.registry.all().some((e) => e.suffix.toLowerCase() === s) && !sessions.some((n) => n.endsWith(`-${s}`))) return s;
    }
    throw new Error('could not find a free suffix');
  }
}
