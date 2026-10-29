/**
 * zulip-cc-spawner daemon — spawns, tracks and reaps Claude Code hands on
 * command from Zulip. See README.md and docs/PLAN.md.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { SpawnerActions } from './actions.js';
import { GroupChecker } from './auth.js';
import { loadConfig, REGISTRY_PATH, STATE_DIR, STATE_PATH } from './config.js';
import { ControlState, ZulipControl } from './control.js';
import { makeHost } from './host.js';
import { ClaudeLauncher } from './launcher.js';
import { ZulipNotifier } from './notifier.js';
import { Provisioner } from './provision.js';
import { Reaper } from './reaper.js';
import { Registry } from './registry.js';
import { Tmux } from './tmux.js';
import { TranscriptWatcher } from './transcript-watch.js';
import { loadZuliprc, ZulipClient } from './zulip.js';

const log = (msg: string) => console.log(`${new Date().toISOString()} [spawner] ${msg}`);

/** One daemon per state dir: two would race on tmux and the registry. */
function acquireLock(path: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(path);
        } catch {
          /* gone */
        }
      };
    } catch {
      const pid = Number(existsSync(path) ? readFileSync(path, 'utf8').trim() : NaN);
      let alive = false;
      try {
        if (Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0);
          alive = true;
        }
      } catch {
        /* not running */
      }
      if (alive) throw new Error(`another spawner is running (pid ${pid}, lock ${path})`);
      unlinkSync(path); // stale
    }
  }
  throw new Error(`could not take the lock ${path}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const release = acquireLock(join(STATE_DIR, 'spawner.lock'));

  const spawnerClient = new ZulipClient(loadZuliprc(config.spawnerRc));
  const adminClient = new ZulipClient(loadZuliprc(config.adminRc));
  if (spawnerClient.site !== adminClient.site) throw new Error(`spawnerRc and adminRc point at different realms (${spawnerClient.site} vs ${adminClient.site})`);

  const registry = new Registry(REGISTRY_PATH);
  registry.load();
  const host = makeHost(config.agentsUser);
  const tmux = new Tmux(host, config.tmuxSocket);
  const notifier = new ZulipNotifier(spawnerClient);
  const provisioner = new Provisioner(adminClient);
  const launcher = new ClaudeLauncher(config, tmux);
  let control: ZulipControl | undefined;
  const watcher = new TranscriptWatcher(
    registry,
    host,
    tmux,
    notifier,
    { agentsHome: config.agentsHome, projectDir: config.projectDir },
    () => control?.name ?? 'spawner',
  );
  // Asked as the hand's own bot: covers every stream it posted in.
  const lastPost = (e: { botEmail: string }) => provisioner.lastPostOf(e.botEmail, (c) => new ZulipClient(c));
  const reaper = new Reaper(registry, tmux, notifier, config, lastPost);
  const actions = new SpawnerActions({
    config,
    registry,
    host,
    tmux,
    provisioner,
    launcher,
    notifier,
    watcher,
    groupCheck: new GroupChecker(spawnerClient).check,
    realm: spawnerClient.site,
  });
  control = new ZulipControl(spawnerClient, actions, notifier, config, new ControlState(STATE_PATH));

  await actions.enqueue(() => reaper.reconcile());
  await control.start();

  const timers = [
    setInterval(() => void actions.enqueue(() => reaper.sweep()), config.reapIntervalMs),
    setInterval(() => void actions.enqueue(() => watcher.sweep()), config.watchIntervalMs),
  ];

  const shutdown = (sig: string) => {
    log(`${sig} — shutting down (hands keep running)`);
    for (const t of timers) clearInterval(t);
    control?.stop();
    registry.save();
    release();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`${new Date().toISOString()} [spawner] fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
