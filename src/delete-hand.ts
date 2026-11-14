/** Destructive filesystem work runs as the agents user, just like provisioning. */
import { resolve } from 'node:path';
import type { SpawnerConfig } from './config.js';
import type { AgentHost } from './host.js';
import type { BotEntry } from './registry.js';
import type { Tmux } from './tmux.js';

export interface DeletionPath { kind: 'hand dir' | 'workDir'; path: string; root: string }
export interface CheckedDeletionPath extends DeletionPath { exists: boolean }

// Validate the ENTIRE plan before removing anything. Never follow a symlink,
// including an intermediate component or a link inside the directory tree.
// Missing paths are safe only when their existing ancestors pass the same checks
// (failed provisioning and retries after partial filesystem cleanup).
export const DELETE_PATHS_JS = String.raw`
const fs = require('node:fs'), path = require('node:path');
const [plan, remove, protectedRoots] = JSON.parse(process.argv[1]);
const removed = [];
try {
  const inside = (root, p) => p !== root && p.startsWith(root + path.sep);
  function canonical(p) {
    try { return fs.realpathSync(p); }
    catch(e) {
      if (e.code !== 'ENOENT') throw e;
      return path.join(canonical(path.dirname(p)), path.basename(p));
    }
  }
  const roots = protectedRoots.map(p => canonical(path.resolve(p)));
  function tree(p) {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) throw Error('symlink refused: ' + p);
    if (st.isDirectory()) for (const name of fs.readdirSync(p)) tree(path.join(p, name));
  }
  // Anchor each traversal in an open directory fd. O_NOFOLLOW applies at
  // EVERY level, not just the top-level hand path; a concurrent link swap
  // must fail, never turn recursive removal into traversal outside the root.
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  function removeAt(parent, name) {
    const target = '/proc/self/fd/' + parent + '/' + name;
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) throw Error('symlink refused during removal: ' + name);
    if (!st.isDirectory()) { fs.unlinkSync(target); return; }
    const fd = fs.openSync(target, flags);
    try { for (const child of fs.readdirSync('/proc/self/fd/' + fd)) removeAt(fd, child); }
    finally { fs.closeSync(fd); }
    fs.rmdirSync(target);
  }
  function removeDir(dir) {
    let fd = fs.openSync(path.parse(dir).root, flags);
    try {
      const parts = dir.slice(path.parse(dir).root.length).split(path.sep);
      for (const part of parts.slice(0, -1)) {
        const next = fs.openSync('/proc/self/fd/' + fd + '/' + part, flags);
        fs.closeSync(fd); fd = next;
      }
      if (fs.realpathSync('/proc/self/fd/' + fd) !== path.dirname(dir)) throw Error('parent moved during removal');
      removeAt(fd, parts[parts.length - 1]);
    } finally { fs.closeSync(fd); }
  }
  const checked = plan.map(p => {
    if (!path.isAbsolute(p.path) || p.path.split(path.sep).includes('..')) throw Error('unsafe path: ' + p.path);
    let ancestor = path.parse(path.resolve(p.root)).root;
    for (const part of path.resolve(p.root).slice(ancestor.length).split(path.sep).filter(Boolean)) {
      ancestor = path.join(ancestor, part);
      if (fs.lstatSync(ancestor).isSymbolicLink()) throw Error('symlink refused: ' + ancestor);
    }
    const root = fs.realpathSync(p.root), lexicalRoot = path.resolve(p.root), dir = path.resolve(p.path);
    if (!inside(lexicalRoot, dir)) throw Error('path must be strictly inside its root: ' + p.path);
    let current = lexicalRoot, exists = true;
    for (const part of path.relative(lexicalRoot, dir).split(path.sep)) {
      current = path.join(current, part);
      if (!exists) continue;
      try { if (fs.lstatSync(current).isSymbolicLink()) throw Error('symlink refused: ' + current); }
      catch(e) { if (e.code !== 'ENOENT') throw e; exists = false; }
      if (exists && !inside(root, fs.realpathSync(current))) throw Error('path escapes root: ' + current);
    }
    // Also protect the OTHER configured root, even under unusual nested config.
    const canonical = path.join(root, path.relative(lexicalRoot, dir));
    if (roots.some(r => canonical === r || inside(canonical, r))) throw Error('refusing to delete a configured root: ' + p.path);
    if (exists) {
      if (!fs.lstatSync(dir).isDirectory()) throw Error('not a directory: ' + dir);
      tree(dir);
    }
    return {...p, exists};
  });
  if (remove) {
    const unique = new Map(checked.map(p => [path.resolve(p.path), p]));
    // A nested path may appear in historical records; remove children first.
    for (const [dir, p] of [...unique].sort(([a], [b]) => b.length - a.length)) {
      if (p.exists) { removeDir(dir); removed.push(dir); }
    }
  }
  console.log(JSON.stringify({paths:checked, removed}));
} catch(e) { console.log(JSON.stringify({error:e.message, removed})); }
`;

export async function deletionPaths(host: AgentHost, cfg: SpawnerConfig, plan: DeletionPath[], remove = false): Promise<{
  paths?: CheckedDeletionPath[]; removed: string[]; error?: string;
}> {
  const { stdout } = await host.exec(cfg.nodeBin, ['-e', DELETE_PATHS_JS, JSON.stringify([plan, remove, [cfg.handsDir, cfg.workRoot ?? resolve(cfg.projectDir, 'hands')]])]);
  return JSON.parse(stdout);
}

// tmux absence alone does not prove a hand stopped: a child can outlive it.
// Linux /proc is inspected as the agents user, without exposing command lines
// or environment (which may contain credentials). Fail closed on unreadable
// same-user processes or unavailable /proc. No pid is persisted in old records.
export const HAND_PROCESSES_JS = String.raw`
const fs = require('node:fs'), path = require('node:path');
const entries = JSON.parse(process.argv[1]), uid = fs.statSync('/proc/self').uid;
const dirs = [...new Set(entries.flatMap(e => [e.handDir, e.workDir].filter(Boolean)))];
const sessions = entries.map(e => e.sessionId).filter(Boolean);
const mentions = s => dirs.some(d => s.includes(d + path.sep) || s === d);
let running = false, unreadable = false;
for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p) && +p !== process.pid)) {
  try {
    const base = '/proc/' + pid;
    if (fs.statSync(base).uid !== uid) continue;
    const args = fs.readFileSync(base + '/cmdline', 'utf8').split('\0');
    if (!args.some(Boolean)) continue; // zombie / kernel thread
    if (args.some(a => sessions.includes(a) || mentions(a))) { running = true; break; }
    const env = fs.readFileSync(base + '/environ', 'utf8').split('\0');
    if (env.some(mentions)) { running = true; break; }
    const cwd = fs.readlinkSync(base + '/cwd').replace(/ \(deleted\)$/, '');
    if (dirs.some(d => cwd === d || cwd.startsWith(d + path.sep))) { running = true; break; }
  } catch(e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') unreadable = true;
    else if (e.code !== 'ENOENT' && e.code !== 'ESRCH') throw e;
  }
}
if (!running && unreadable) throw Error('cannot rule out a running hand: unreadable same-user process');
console.log(JSON.stringify(running));
`;

/** Reuse tmux's fail-closed absence check, then look for surviving processes. */
export async function handStopped(host: AgentHost, tmux: Tmux, cfg: SpawnerConfig, entries: readonly BotEntry[]): Promise<boolean> {
  if (entries.some(e => ['alive', 'provisioning', 'cleanup'].includes(e.status))) return false;
  if (await tmux.hasSession(entries[0].tmuxSession)) return false;
  const { stdout } = await host.exec(cfg.nodeBin, ['-e', HAND_PROCESSES_JS,
    JSON.stringify(entries.map(({ handDir, workDir, sessionId }) => ({ handDir, workDir, sessionId })))]);
  const running: unknown = JSON.parse(stdout);
  if (typeof running !== 'boolean') throw new Error('invalid process liveness response');
  return !running;
}
