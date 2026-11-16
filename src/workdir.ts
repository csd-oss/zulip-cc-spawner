import { DIRECTORY_OWNER_JS, type DirectoryIdentity } from './directory-owner.js';
import { join, resolve } from 'node:path';
import type { SpawnerConfig } from './config.js';
import type { AgentHost } from './host.js';

// Runs as the hand user, not the daemon. A separate lock directory serializes
// cooperating spawns across processes; never unlink a potentially live lock.
// Timeout fails closed (operator may remove a stale lock after checking owners).
export const PREPARE_WORKDIR_JS = DIRECTORY_OWNER_JS + String.raw`
const fs = require('node:fs/promises'), path = require('node:path');
// Pre-attestation workspaces (legacy registry: workDirReady, no identity) are
// adopted only at <workRoot>/<tmux-name>, owned by this user, canonical, on the
// root's device with no mount at/below it, not a configured root and not
// overlapping another hand's recorded paths (by name or inode). The marker is
// created O_EXCL through the directory fd: an existing marker (someone else's
// attested folder) refuses. The result proves continuity from now on, never
// creation: callers record it apart from workDirIdentity.
function adoptLegacyDirectory(dir, opts) {
  const crypto = require('node:crypto');
  const inside = (r, p) => p !== r && p.startsWith(r + path.sep);
  const key = st => st.dev + ':' + st.ino;
  function canonical(p) {
    try { return ownerFS.realpathSync(p); }
    catch(e) {
      if (e.code !== 'ENOENT') throw e;
      return path.join(canonical(path.dirname(p)), path.basename(p));
    }
  }
  const root = path.resolve(opts.root);
  if (path.resolve(dir) !== dir || path.dirname(dir) !== root || path.basename(dir) !== opts.name)
    throw Error('not this hand directory under workRoot');
  let current = path.parse(dir).root;
  for (const part of dir.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (ownerFS.lstatSync(current).isSymbolicLink()) throw Error('symlink refused');
  }
  if (ownerFS.realpathSync(dir) !== dir) throw Error('path is not canonical');
  const roots = opts.roots.map(p => canonical(path.resolve(p)));
  const refs = opts.references.map(p => canonical(path.resolve(p)));
  if (roots.some(r => r === dir || inside(dir, r))) throw Error('configured root refused');
  if (refs.some(r => r === dir || inside(dir, r) || inside(r, dir))) throw Error('directory shared with another hand');
  // realpath does not see bind-mount aliases: compare inodes as well. As in
  // legacy delete, a root/reference and all its ancestors are protected (the
  // folder must not be, or contain, one of them under another name).
  const protectedKeys = new Set(), refKeys = new Set();
  for (const ref of [...roots, ...refs]) {
    for (let a = ref; ; a = path.dirname(a)) {
      try {
        const k = key(ownerFS.statSync(a));
        protectedKeys.add(k);
        if (a === ref && refs.includes(ref)) refKeys.add(k);
      } catch(e) { if (e.code !== 'ENOENT') throw e; }
      if (a === path.dirname(a)) break;
    }
  }
  for (let a = path.dirname(dir); ; a = path.dirname(a)) {
    if (refKeys.has(key(ownerFS.statSync(a)))) throw Error('directory shared with another hand');
    if (a === path.dirname(a)) break;
  }
  const mounts = ownerFS.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').map(line =>
    line.split(' ')[4].replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8))));
  if (mounts.some(m => m === dir || inside(dir, m))) throw Error('mount point refused');
  const fd = ownerFS.openSync(dir, ownerFlags);
  let created = false;
  const base = '/proc/self/fd/' + fd;
  try {
    const st = ownerFS.fstatSync(fd);
    if (!st.isDirectory() || st.uid !== process.getuid()) throw Error('not owned by the agents user');
    if (st.dev !== ownerFS.statSync(root).dev) throw Error('mount point refused (different device)');
    if (protectedKeys.has(key(st))) throw Error('directory shared with another hand');
    const nonce = crypto.randomBytes(32).toString('hex');
    let marker;
    try {
      marker = ownerFS.openSync(base + '/.cc-spawner-owner',
        ownerFS.constants.O_WRONLY | ownerFS.constants.O_CREAT | ownerFS.constants.O_EXCL |
        ownerFS.constants.O_NOFOLLOW, 0o600);
    } catch(e) {
      if (e.code === 'EEXIST') throw Error('directory already carries an ownership marker');
      throw e;
    }
    created = true;
    try { ownerFS.writeFileSync(marker, nonce); } finally { ownerFS.closeSync(marker); }
    const identity = {dev:st.dev, ino:st.ino, nonce};
    if (!ownerMatches(fd, [identity])) throw Error('adoption attestation failed');
    const now = ownerFS.lstatSync(dir);
    if (now.isSymbolicLink() || now.dev !== st.dev || now.ino !== st.ino) throw Error('directory moved during adoption');
    // Only after every check: the pre-attestation spawner did this on each preparation.
    ownerFS.fchmodSync(fd, 0o700);
    created = false;
    return identity;
  } finally {
    // Only our own just-created marker, anchored to the adopted fd.
    if (created) { try { ownerFS.unlinkSync(base + '/.cc-spawner-owner'); } catch {} }
    ownerFS.closeSync(fd);
  }
}
// A later failure (e.g. trust config) must not strand our marker: the registry
// never learns the nonce, and the next revival would refuse (EEXIST). Remove it
// only from this same directory and only if it still holds our nonce.
function retractAdoption(dir, identity) {
  const fd = ownerFS.openSync(dir, ownerFlags);
  try { if (ownerMatches(fd, [identity])) ownerFS.unlinkSync('/proc/self/fd/' + fd + '/.cc-spawner-owner'); }
  finally { ownerFS.closeSync(fd); }
}
let retract;
(async () => {
  const [dir, file, mode] = process.argv.slice(1);
  if (!path.isAbsolute(dir)) throw Error('workDir must be absolute');
  if (mode !== 'adopt-legacy') await fs.mkdir(path.dirname(dir), {recursive:true, mode:0o700});
  const expected = JSON.parse(process.argv[5] || 'null');
  let identity;
  try {
    identity = mode === 'yes' ? createOwnedDirectory(dir) :
      mode === 'adopt-legacy' ? adoptLegacyDirectory(dir, JSON.parse(process.argv[6])) : attestDirectory(dir, expected);
  } catch(e) {
    throw Error('Workspace preparation failed: ' + dir + '. Refusing to adopt it. ' + e.message);
  }
  if (!identity)
    throw Error('Workspace already exists: ' + dir + '. Refusing to adopt it: directory identity is unattested.');
  if (mode === 'adopt-legacy') retract = () => retractAdoption(dir, identity);
  if (process.argv[4] === 'no-trust') { console.log(JSON.stringify(identity)); return; }
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
    console.log(JSON.stringify(identity));
  } finally {
    await fs.rm(tmp, {force:true});
    await fs.rmdir(lock);
  }
})().catch(e => {
  try { retract?.(); } catch(r) { e.message += ' (adoption marker could not be retracted: ' + r.message + ')'; }
  console.error(e.message); process.exitCode = 1;
});
`;

export type PrepareMode =
  | { kind: 'fresh' }
  | { kind: 'attest'; identity?: DirectoryIdentity }
  /** Pre-attestation workspace at <workRoot>/<name>; see adoptLegacyDirectory. */
  | { kind: 'adopt-legacy'; name: string; references: string[] };

export async function prepareWorkDir(host: AgentHost, cfg: SpawnerConfig, workDir: string, mode: PrepareMode, claudeTrust = true): Promise<DirectoryIdentity | undefined> {
  const workRoot = cfg.workRoot ?? resolve(cfg.projectDir, 'hands');
  const { stdout } = await host.exec(cfg.nodeBin, ['-e', PREPARE_WORKDIR_JS, workDir, join(cfg.agentsHome, '.claude.json'),
    mode.kind === 'fresh' ? 'yes' : mode.kind === 'attest' ? 'no' : 'adopt-legacy', claudeTrust ? 'trust' : 'no-trust',
    JSON.stringify(mode.kind === 'attest' ? mode.identity ?? null : null),
    ...(mode.kind === 'adopt-legacy' ? [JSON.stringify({ root: workRoot, name: mode.name,
      roots: [cfg.handsDir, workRoot, cfg.projectDir], references: mode.references })] : [])]);
  return stdout.trim() ? JSON.parse(stdout) : undefined;
}
