import type { AgentHost } from './host.js';
import type { SpawnerConfig } from './config.js';

// Apparent regular-file bytes, deduplicated hardlinks per directory. Fd-anchored
// O_NOFOLLOW traversal includes hidden files but never follows directory links.
export const WORKDIR_SIZES_JS = `
const { Worker } = require('node:worker_threads');
const dirs = JSON.parse(process.argv[1]);
const worker = new Worker(\`
  const { parentPort, workerData: dirs } = require('node:worker_threads');
  const fs = require('node:fs'), path = require('node:path');
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  const globalDeadline = Date.now() + 2000;
  const results = dirs.map(dir => {
    let bytes = 0, partial = false, count = 0;
    const seen = new Set(), deadline = Math.min(globalDeadline, Date.now() + 100);
    function walk(fd, dev, depth) {
      if (depth > 100) { partial = true; return; }
      const handle = fs.opendirSync('/proc/self/fd/' + fd);
      try {
        let ent;
        while ((ent = handle.readSync())) {
          if (++count > 10000 || Date.now() > deadline) { partial = true; break; }
          const p = '/proc/self/fd/' + fd + '/' + ent.name;
          try {
            const st = fs.lstatSync(p);
            if (st.dev !== dev) { partial = true; continue; }
            if (st.isSymbolicLink()) continue;
            const key = st.dev + ':' + st.ino;
            if (seen.has(key)) continue;
            seen.add(key);
            if (st.isFile()) {
              if (st.size > Number.MAX_SAFE_INTEGER - bytes) {
                bytes = Number.MAX_SAFE_INTEGER; partial = true;
              } else bytes += st.size;
            }
            else if (st.isDirectory()) {
              const child = fs.openSync(p, flags);
              try {
                const actual = fs.fstatSync(child);
                if (actual.dev !== dev || actual.ino !== st.ino) partial = true;
                else walk(child, dev, depth + 1);
              } finally { fs.closeSync(child); }
            }
          } catch { partial = true; }
        }
      } finally { handle.closeSync(); }
    }
    let fd;
    try {
      if (!path.isAbsolute(dir) || Date.now() > globalDeadline) throw Error();
      fd = fs.openSync('/', flags);
      for (const part of path.resolve(dir).split('/').filter(Boolean)) {
        const next = fs.openSync('/proc/self/fd/' + fd + '/' + part, flags);
        fs.closeSync(fd); fd = next;
      }
      walk(fd, fs.fstatSync(fd).dev, 0);
      return { bytes, partial };
    } catch { return { bytes, partial: true }; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  });
  parentPort.postMessage(results);
\`, { eval: true, workerData: dirs });
const timer = setTimeout(() => finish(dirs.map(() => ({ bytes: 0, partial: true }))), 3000);
function finish(result) { console.log(JSON.stringify(result)); process.exit(0); }
worker.on('message', finish);
worker.on('error', () => finish(dirs.map(() => ({ bytes: 0, partial: true }))));
`;

export async function workdirSizes(host: AgentHost, cfg: SpawnerConfig, dirs: string[]) {
  try {
    const unique = [...new Set(dirs)];
    const { stdout } = await host.exec(cfg.nodeBin, ['-e', WORKDIR_SIZES_JS, JSON.stringify(unique)]);
    const values = JSON.parse(stdout) as { bytes: number; partial: boolean }[];
    if (values.length !== unique.length || values.some(v => !Number.isSafeInteger(v.bytes) || v.bytes < 0 || typeof v.partial !== 'boolean')) throw Error();
    return dirs.map(dir => values[unique.indexOf(dir)]);
  } catch { return dirs.map(() => ({ bytes: 0, partial: true })); }
}


// Decimal MB keeps inventories readable; floor lower bounds so rounding never
// overstates measured bytes. Unknown/partial zero remains explicitly labelled.
export function formatWorkdirSize(size: { bytes: number; partial: boolean }): string {
  const gb = size.bytes >= 1_000_000_000;
  const value = size.bytes / (gb ? 1_000_000_000 : 1_000_000);
  const rounded = size.partial ? Math.floor(value * 100) / 100 : Math.round(value * 100) / 100;
  return `${size.partial ? '≥' : ''}${rounded} ${gb ? 'GB' : 'MB'}${size.partial ? ' (partial/unknown)' : ''}`;
}
