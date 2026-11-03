import { join } from 'node:path';
import type { SpawnerConfig } from './config.js';
import type { AgentHost } from './host.js';

// Runs as the hand user, not the daemon. A separate lock directory serializes
// cooperating spawns across processes; never unlink a potentially live lock.
// Timeout fails closed (operator may remove a stale lock after checking owners).
export const PREPARE_WORKDIR_JS = String.raw`
const fs = require('node:fs/promises'), path = require('node:path');
(async () => {
  const [dir, file, fresh] = process.argv.slice(1);
  if (!path.isAbsolute(dir)) throw Error('workDir must be absolute');
  await fs.mkdir(path.dirname(dir), {recursive:true, mode:0o700});
  if (fresh === 'yes') await fs.mkdir(dir, {mode:0o700});
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error('unsafe workDir');
  await fs.chmod(dir, 0o700);
  await fs.mkdir(path.dirname(file), {recursive:true, mode:0o700});
  const lock = file + '.spawner-lock';
  const deadline = Date.now() + 10000;
  for (;;) {
    try { await fs.mkdir(lock, {mode:0o700}); break; }
    catch(e) {
      if (e.code !== 'EEXIST' || Date.now() >= deadline) throw e;
      await new Promise(r => setTimeout(r, 25));
    }
  }
  const tmp = path.join(lock, 'config.tmp');
  try {
    let j = {};
    try { j = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch(e) { if (e.code !== 'ENOENT') throw e; }
    const object = x => x && typeof x === 'object' && !Array.isArray(x);
    if (!object(j) || (j.projects !== undefined && !object(j.projects))) throw Error('invalid Claude config');
    j.projects ??= {};
    const project = j.projects[dir] ?? {};
    if (!object(project)) throw Error('invalid Claude project config');
    j.projects[dir] = {...project, hasTrustDialogAccepted:true};
    const handle = await fs.open(tmp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(j, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, {force:true});
    await fs.rmdir(lock);
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
`;

export async function prepareWorkDir(host: AgentHost, cfg: SpawnerConfig, workDir: string, fresh: boolean): Promise<void> {
  await host.exec(cfg.nodeBin, ['-e', PREPARE_WORKDIR_JS, workDir, join(cfg.agentsHome, '.claude.json'), fresh ? 'yes' : 'no']);
}
