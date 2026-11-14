import { DIRECTORY_OWNER_JS, type DirectoryIdentity } from './directory-owner.js';
/** Destructive filesystem work runs as the agents user, just like provisioning. */
import { resolve } from 'node:path';
import type { SpawnerConfig } from './config.js';
import type { AgentHost } from './host.js';
import type { BotEntry } from './registry.js';
import type { Tmux } from './tmux.js';

export interface DeletionPath { kind: 'hand dir' | 'workDir'; path: string; root: string; recursive?: boolean; identities?: DirectoryIdentity[]; legacy?: boolean; snapshot?: { dev: number; ino: number } }
export interface CheckedDeletionPath extends DeletionPath { exists: boolean; kept?: boolean }

// Validate the ENTIRE plan before removing anything. Never follow a symlink,
// including an intermediate component or a link inside the directory tree.
// Missing paths are safe only when their existing ancestors pass the same checks
// (failed provisioning and retries after partial filesystem cleanup).
export const DELETE_PATHS_JS = DIRECTORY_OWNER_JS + String.raw`
const fs = require('node:fs'), path = require('node:path');
const [plan, remove, protectedRoots, references = []] = JSON.parse(process.argv[1]);
const removed = [];
const errno = e => ['EACCES','EPERM','ENOENT','ESRCH','EIO','ENOTDIR','EMFILE','ENFILE','EINVAL','ENOSYS','EOVERFLOW','ELOOP','ENXIO','ENOMEM','EBADF','EBUSY','ENOTEMPTY','EEXIST','UNATTESTED'].includes(e?.code) ? e.code : 'unexpected';
const refuse = cause => Object.assign(Error(), {causeClass: cause});
let stage = 'setup', rootKind;

try {
  const inside = (root, p) => p !== root && p.startsWith(root + path.sep);
  function canonical(p) {
    try { return fs.realpathSync(p); }
    catch(e) {
      if (e.code !== 'ENOENT') throw e;
      return path.join(canonical(path.dirname(p)), path.basename(p));
    }
  }
  const refs = references.map(p => canonical(path.resolve(p)));
  const roots = protectedRoots.map(p => canonical(path.resolve(p)));
  const inodeKey = st => st.dev + ':' + st.ino;
  const protectedInodes = new Set(), referenceInodes = new Set();
  if (plan.some(p => p.legacy)) {
    // realpath does not resolve bind-mount aliases. Protect reference identities
    // and their ancestors as well as lexical/canonical spellings.
    for (const ref of [...refs, ...roots]) {
      let current = ref;
      while (true) {
        try {
          const key = inodeKey(fs.statSync(current));
          protectedInodes.add(key);
          if (current === ref && refs.includes(ref)) referenceInodes.add(key);
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
  }
  function protect(st) {
    if (protectedInodes.has(inodeKey(st))) throw refuse('directory shared with another hand');
  }
  function tree(p, dev) {
    const st = fs.lstatSync(p);
    protect(st);
    if (st.isSymbolicLink()) throw refuse('symlink refused');
    if (st.dev !== dev) throw refuse('mount point refused (different device)');
    if (st.isDirectory()) for (const name of fs.readdirSync(p)) tree(path.join(p, name), dev);
  }
  // Anchor each traversal in an open directory fd. O_NOFOLLOW applies at
  // EVERY level, not just the top-level hand path; a concurrent link swap
  // must fail, never turn recursive removal into traversal outside the root.
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  const matches = (st, identities) => identities?.some(id => id.dev === st.dev && id.ino === st.ino);
  function removeAt(parent, name, dev, recursive, identities, snapshot) {
    const target = '/proc/self/fd/' + parent + '/' + name;
    const st = fs.lstatSync(target);
    protect(st);
    if (st.isSymbolicLink()) throw refuse('symlink refused during removal');
    if (st.dev !== dev) throw refuse('mount point refused during removal (different device)');
    if (snapshot && !matches(st, [snapshot])) throw refuse('directory changed since preview');
    if (recursive && identities && !matches(st, identities)) throw Object.assign(Error('directory identity changed'), {code:'UNATTESTED'});
    if (!recursive) { fs.rmdirSync(target); return; }
    if (!st.isDirectory()) { fs.unlinkSync(target); return; }
    const fd = fs.openSync(target, flags);
    try {
      if (fs.fstatSync(fd).dev !== dev) throw refuse('mount point refused during removal (different device)');
      if (snapshot && !matches(fs.fstatSync(fd), [snapshot])) throw refuse('directory changed since preview');
      if (identities && !ownerMatches(fd, identities)) throw Object.assign(Error('directory identity changed'), {code:'UNATTESTED'});
      for (const child of fs.readdirSync('/proc/self/fd/' + fd)) removeAt(fd, child, dev, true);
    }
    finally { fs.closeSync(fd); }
    fs.rmdirSync(target);
  }
  function removeDir(dir, dev, recursive, identities, snapshot) {
    let fd = fs.openSync(path.parse(dir).root, flags);
    try {
      const parts = dir.slice(path.parse(dir).root.length).split(path.sep);
      for (const part of parts.slice(0, -1)) {
        const next = fs.openSync('/proc/self/fd/' + fd + '/' + part, flags);
        fs.closeSync(fd); fd = next;
      }
      if (fs.realpathSync('/proc/self/fd/' + fd) !== path.dirname(dir)) throw refuse('parent moved during removal');
      removeAt(fd, parts[parts.length - 1], dev, recursive, identities, snapshot);
    } finally { fs.closeSync(fd); }
  }
  const checked = plan.map(p => {
    stage = 'preview'; rootKind = p.kind === 'hand dir' ? 'hand dir' : 'workDir';
    if (!path.isAbsolute(p.path) || p.path.split(path.sep).includes('..')) throw refuse('unsafe path');
    let ancestor = path.parse(path.resolve(p.root)).root;
    for (const part of path.resolve(p.root).slice(ancestor.length).split(path.sep).filter(Boolean)) {
      ancestor = path.join(ancestor, part);
      if (fs.lstatSync(ancestor).isSymbolicLink()) throw refuse('symlink refused');
    }
    const root = fs.realpathSync(p.root), lexicalRoot = path.resolve(p.root), dir = path.resolve(p.path);
    if (!inside(lexicalRoot, dir)) throw refuse('path must be strictly inside its root');
    const dev = fs.lstatSync(root).dev;
    let current = lexicalRoot, exists = true;
    for (const part of path.relative(lexicalRoot, dir).split(path.sep)) {
      current = path.join(current, part);
      if (!exists) continue;
      try {
        const st = fs.lstatSync(current);
        if (st.isSymbolicLink()) throw refuse('symlink refused');
        if (st.dev !== dev) throw refuse('mount point refused (different device)');
      }
      catch(e) { if (e.code !== 'ENOENT') throw e; exists = false; }
      if (exists && !inside(root, fs.realpathSync(current))) throw refuse('path escapes root');
    }
    // Also protect the OTHER configured root, even under unusual nested config.
    const canonical = path.join(root, path.relative(lexicalRoot, dir));
    if (roots.some(r => canonical === r || inside(canonical, r))) throw refuse('refusing to delete a configured root');
    if (refs.some(r => canonical === r || inside(canonical, r) || inside(r, canonical))) throw refuse('directory shared with another hand');
    if (p.legacy) {
      let ancestor = dir;
      while (true) {
        try {
          if (referenceInodes.has(inodeKey(fs.statSync(ancestor)))) throw refuse('directory shared with another hand');
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      // Bind mounts can share st_dev. Refuse all visible mount boundaries.
      const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').map(line =>
        line.split(' ')[4].replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8))));
      if (mounts.some(m => m === dir || inside(dir, m))) throw refuse('mount point refused (different device)');
    }
    if (exists) {
      if (!fs.lstatSync(dir).isDirectory()) throw refuse('not a directory');
      const fd = fs.openSync(dir, flags);
      try {
        if (p.legacy) {
          const st = fs.fstatSync(fd);
          if (p.snapshot && !matches(st, [p.snapshot])) throw refuse('directory changed since preview');
          if (remove && !p.snapshot) throw refuse('directory changed since preview');
          p.snapshot = { dev: st.dev, ino: st.ino };
          p.recursive = true;
          p.identities = undefined;
        } else p.recursive = Boolean(p.recursive && ownerMatches(fd, p.identities));
      }
      finally { fs.closeSync(fd); }
      if (p.recursive) tree(dir, dev);
    }
    return {...p, exists, dev, kept: exists && !p.recursive && fs.readdirSync(dir).length > 0};
  });
  // Identity checks can downgrade a descendant after the plan was assembled.
  for (const p of checked) {
    rootKind = p.kind === 'hand dir' ? 'hand dir' : 'workDir';
    if (checked.some(child => !child.recursive && (path.resolve(child.path) === path.resolve(p.path) ||
      inside(path.resolve(p.path), path.resolve(child.path))))) {
      p.recursive = false;
      p.kept = p.exists && fs.readdirSync(p.path).length > 0;
    }
  }
  if (remove) {
    stage = 'removal'; rootKind = undefined;
    if (checked.some(p => p.kept && checked.some(parent => parent.exists && !parent.kept &&
      inside(path.resolve(parent.path), path.resolve(p.path))))) throw refuse('kept directory nested in removal plan');
    const unique = new Map(checked.map(p => [path.resolve(p.path), p]));
    // A nested path may appear in historical records; remove children first.
    for (const [dir, p] of [...unique].sort(([a], [b]) => b.length - a.length)) {
      rootKind = p.kind === 'hand dir' ? 'hand dir' : 'workDir';
      if (p.exists && !p.kept) {
        try {
          if (checked.some(child => child.kept && inside(dir, path.resolve(child.path)))) { p.kept = true; continue; }
          removeDir(dir, p.dev, Boolean(p.recursive), p.identities, p.snapshot); removed.push(dir);
        }
        catch(e) {
          if (e.code === 'UNATTESTED') { p.recursive = false; p.kept = true; }
          else if (!p.recursive && (e.code === 'ENOTEMPTY' || e.code === 'EEXIST')) p.kept = true;
          else throw e;
        }
      }
    }
  }
  console.log(JSON.stringify({paths:checked, removed}));
} catch(e) { console.log(JSON.stringify({error: {cause: e.causeClass || 'filesystem', errno: errno(e), stage, rootKind}, removed})); }
`;

export async function deletionPaths(host: AgentHost, cfg: SpawnerConfig, plan: DeletionPath[], remove = false, references: string[] = []): Promise<{
  paths?: CheckedDeletionPath[]; removed: string[]; error?: string;
}> {
  const { stdout } = await helperExec(() => host.exec(cfg.nodeBin, ['-e', DELETE_PATHS_JS, JSON.stringify([plan, remove, [cfg.handsDir, cfg.workRoot ?? resolve(cfg.projectDir, 'hands'), cfg.projectDir], references])]));
  const result = JSON.parse(stdout);
  if (result.error) {
    // Validate even successful-exec error output before rendering it to Zulip.
    const e = result.error;
    const causes = ['filesystem', 'symlink refused', 'mount point refused (different device)',
      'symlink refused during removal', 'mount point refused during removal (different device)',
      'parent moved during removal', 'unsafe path', 'path must be strictly inside its root',
      'path escapes root', 'refusing to delete a configured root', 'not a directory',
      'kept directory nested in removal plan', 'directory shared with another hand', 'directory changed since preview'];
    const codes = ['EACCES','EPERM','ENOENT','ESRCH','EIO','ENOTDIR','EMFILE','ENFILE','EINVAL','ENOSYS','EOVERFLOW','ELOOP','ENXIO','ENOMEM','EBADF','EBUSY','ENOTEMPTY','EEXIST','UNATTESTED'];
    const cause = causes.includes(e.cause) ? e.cause : 'helper-error';
    const code = codes.includes(e.errno) ? e.errno : 'unexpected';
    const stage = ['setup', 'preview', 'removal'].includes(e.stage) ? e.stage : 'unknown-stage';
    const root = ['hand dir', 'workDir'].includes(e.rootKind) ? `; ${e.rootKind}` : '';
    result.error = `${cause}; ${code}; ${stage}${root}`;
  }
  return result;
}

// tmux absence alone does not prove a hand stopped: children can outlive it.
export const HAND_PROCESSES_JS = String.raw`
const fs = require('node:fs'), path = require('node:path');
const errno = e => ['EACCES','EPERM','ENOENT','ESRCH','EIO','ENOTDIR','EMFILE','ENFILE','EINVAL','ENOSYS','EOVERFLOW','ELOOP','ENXIO','ENOMEM','EBADF','EBUSY'].includes(e?.code) ? e.code : 'unexpected';
const gone = e => e.code === 'ENOENT' || e.code === 'ESRCH';
const diagnostics = [];
let running = false, ambiguous = 0, stage = 'setup';
try {
const entries = JSON.parse(process.argv[1]), panes = JSON.parse(process.argv[2] || '[]');
const uid = fs.statSync('/proc/self').uid;
const dirs = [...new Set(entries.flatMap(e => [e.handDir, e.workDir].filter(Boolean)))];
const exactCwds = entries.map(e => e.implicitWorkDir).filter(Boolean);
const sessions = entries.map(e => e.sessionId).filter(Boolean);
const mentions = s => dirs.some(d => s.includes(d + path.sep) || s === d);
function stat(pid) {
  const raw = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  const ppid = Number(fields[1]), start = fields[19];
  if (!Number.isSafeInteger(ppid) || !/^\d+$/.test(start)) throw Error('stat-format');
  return {ppid, start};
}
function otherPane(pid) {
  // Diagnostic context only: panes can move between sessions and their PIDs
  // can be reused. Membership never proves a different launch identity.
  const chain = new Map();
  try {
    while (pid > 1 && chain.size < 256 && !chain.has(pid)) {
      const st = stat(pid); chain.set(pid, st);
      if (panes.some(p => p.pid === pid)) {
        return [...chain].every(([id, old]) => { const now = stat(id); return old.start === now.start && old.ppid === now.ppid; });
      }
      pid = st.ppid;
    }
  } catch {} // Missing/hidden ancestry is not evidence of unrelatedness.
  return false;
}
function hints(base) {
  const result = {};
  try {
    const status = fs.readFileSync(base + '/status', 'utf8');
    for (const key of ['Uid','Gid','NSpid','Dumpable']) {
      const line = status.split('\n').find(l => l.startsWith(key + ':'));
      const values = line?.slice(key.length + 1).trim().split(/\s+/);
      if (values?.every(v => /^\d+$/.test(v))) result[key === 'NSpid' ? 'namespaceDepth' : key] = key === 'NSpid' ? values.length : values.map(Number);
    }
  } catch(e) { result.status = errno(e); }
  try {
    const groups = fs.readFileSync(base + '/cgroup', 'utf8').trim().split('\n');
    // Never serialize cgroup paths: unit/container names can contain secrets.
    result.cgroup = {entries: groups.length, unified: groups.some(l => l.startsWith('0::')), nonRoot: groups.some(l => !l.endsWith(':/'))};
  } catch(e) { result.cgroup = errno(e); }
  return result;
}
stage = 'proc-list';
for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p) && +p !== process.pid)) {
  const base = '/proc/' + pid;
  // Only absence of the tgid directory establishes disappearance. Field
  // ENOENT (notably a pthread_exit leader's cwd) says nothing about workers.
  try {
    stage = 'owner';
    if (fs.statSync(base).uid !== uid) continue;
  } catch(e) { if (gone(e)) continue; throw e; }
  const failures = [];
  const read = (field, fn) => {
    try { return fn(); }
    catch(e) { failures.push({e, stage: field}); }
  };
  const before = read('stat', () => stat(pid));
  const args = read('cmdline', () => fs.readFileSync(base + '/cmdline', 'utf8').split('\0'));
  if (args?.some(a => sessions.includes(a) || mentions(a))) running = true;
  function inspect(target) {
    const env = read('environ', () => fs.readFileSync(target + '/environ', 'utf8').split('\0'));
    const cwd = read('cwd', () => fs.readlinkSync(target + '/cwd').replace(/ \(deleted\)$/, ''));
    if (env?.some(mentions) || cwd !== undefined && (mentions(cwd) || exactCwds.includes(cwd))) running = true;
  }
  inspect(base);
  const tasks = read('task-list', () => fs.readdirSync(base + '/task'));
  if (tasks) {
    if (!tasks.some(tid => /^\d+$/.test(tid))) failures.push({e: {}, stage: 'task-list'});
    for (const tid of tasks.filter(tid => /^\d+$/.test(tid))) inspect(base + '/task/' + tid);
  }
  // Revalidate identity after all task reads. Reuse is ambiguity, not absence.
  let disappeared = false;
  read('owner', () => {
    try { fs.statSync(base); }
    catch(e) { if (gone(e)) { disappeared = true; return; } throw e; }
  });
  if (!disappeared) {
    const after = read('stat', () => stat(pid));
    if (before && after && before.start !== after.start) failures.push({e: {}, stage: 'stat'});
  }
  // Permission evidence is sticky, even if subsequent fields or the directory
  // disappear. Do not reclassify a denied process by name, state or new owner.
  const denied = failures.find(({e}) => e.code === 'EACCES' || e.code === 'EPERM');
  if (failures.length && (!disappeared || denied)) {
    const failure = denied || failures[0];
    diagnostics.push({pid: +pid, errno: errno(failure.e), stage: failure.stage,
      classification: 'ambiguous', otherPaneAncestry: otherPane(+pid), ...hints(base)});
    ambiguous++;
  }
}
if (diagnostics.length) console.log(JSON.stringify({running, error: !running && ambiguous ? 'unreadable-process' : undefined, ambiguous, unreadable: diagnostics.length, diagnostics}));
else console.log(JSON.stringify(running));
} catch(e) {
  console.log(JSON.stringify({error: 'helper-error', errno: errno(e), stage, unreadable: diagnostics.length, diagnostics}));
}
`;

/** Only these errors carry a deliberately secret-free message to Zulip. */
export class ProcessLivenessError extends Error {}

/** Shared secret-free classification for every delete/list helper execution. */
async function helperExec<T>(exec: () => Promise<T>, stage = 'process'): Promise<T> {
  try { return await exec(); }
  catch (err) {
    const e = err as {code?: unknown; stderr?: unknown};
    const code = typeof e?.code === 'number' ? `exit-${e?.code}` : ['ENOENT','EACCES','EPERM'].includes(String(e?.code)) ? String(e?.code) : 'unknown';
    const stderr = String(e?.stderr ?? '');
    const stderrClass = /permission denied|operation not permitted/i.test(stderr) ? 'permission' : /not found|no such file/i.test(stderr) ? 'missing' : stderr ? 'present' : 'empty';
    console.warn('[liveness] ' + JSON.stringify({error: 'exec', code, stderrClass}));
    throw new ProcessLivenessError(`${stage} liveness check failed (exec ${code}; stderr ${stderrClass})`);
  }
}

/** Reuse tmux's fail-closed absence check, then look for surviving processes. */
export async function handStopped(host: AgentHost, tmux: Tmux, cfg: SpawnerConfig, entries: readonly BotEntry[]): Promise<boolean> {
  if (entries.some(e => ['alive', 'provisioning', 'cleanup'].includes(e.status))) return false;
  if (await helperExec(() => tmux.hasSession(entries[0].tmuxSession), 'tmux')) return false;
  const fail = (cause: string): never => { console.warn('[liveness] ' + cause); throw new ProcessLivenessError(`process liveness check failed (${cause})`); };
  // Pane enumeration is optional diagnostic context, never deletion evidence.
  const paneRoots = () => helperExec(() => tmux.otherPaneRoots(entries.map(e => e.tmuxSession))).catch(() => {
    console.warn('[liveness] pane-evidence-unavailable');
    return [];
  });
  const panes = await paneRoots();
  const { stdout } = await helperExec(() => host.exec(cfg.nodeBin, ['-e', HAND_PROCESSES_JS,
    JSON.stringify(entries.map(({ handDir, workDir, sessionId }) => ({ handDir, workDir, implicitWorkDir: workDir ? undefined : cfg.projectDir, sessionId }))), JSON.stringify(panes)]));
  let result;
  try { result = JSON.parse(stdout); } catch { return fail('invalid-response'); }
  if (typeof result === 'boolean') return !result;
  if (!result || !Array.isArray(result.diagnostics)) return fail('invalid-response');
  // Only the helper's explicitly projected fields are emitted; never stderr,
  // Error.message, cmdline, environment, cwd or raw cgroup/status contents.
  console.warn('[liveness] ' + JSON.stringify(result));
  if (result.error) return fail(`${result.error}; ${result.errno ?? [...new Set(result.diagnostics.map((d: {errno: string}) => d.errno))].join('/')}; ${result.stage ?? 'process-scan'}; unreadable=${result.unreadable}`);
  if (typeof result.running !== 'boolean') return fail('invalid-response');
  return !result.running;
}
