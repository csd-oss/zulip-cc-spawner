// Optional nonce permits reading old registries, but never authorizes them.
export interface DirectoryIdentity { dev: number; ino: number; nonce?: string }

// Executed as the agents user. Linux fd-relative paths keep marker operations
// anchored to the opened directory, even when its public pathname moves.
export const DIRECTORY_OWNER_JS = String.raw`
const ownerFS = require('node:fs');
const ownerFlags = ownerFS.constants.O_RDONLY | ownerFS.constants.O_DIRECTORY | ownerFS.constants.O_NOFOLLOW;
function ownerMatches(fd, identities) {
  const st = ownerFS.fstatSync(fd);
  if (st.uid !== process.getuid()) return false;
  let marker;
  try {
    marker = ownerFS.openSync('/proc/self/fd/' + fd + '/.cc-spawner-owner',
      ownerFS.constants.O_RDONLY | ownerFS.constants.O_NOFOLLOW | ownerFS.constants.O_NONBLOCK);
    const ms = ownerFS.fstatSync(marker);
    if (!ms.isFile() || ms.uid !== process.getuid() || ms.size !== 64) return false;
    const nonce = ownerFS.readFileSync(marker, 'utf8');
    return identities?.some(id => id.dev === st.dev && id.ino === st.ino &&
      typeof id.nonce === 'string' && id.nonce === nonce) ?? false;
  } catch { return false; }
  finally { if (marker !== undefined) ownerFS.closeSync(marker); }
}
function attestDirectory(dir, old) {
  const fd = ownerFS.openSync(dir, ownerFlags);
  try { return ownerMatches(fd, [old].filter(Boolean)) ? old : null; }
  finally { ownerFS.closeSync(fd); }
}
// Node has no renameat2 binding. Python's stdlib ctypes invokes the Linux libc
// wrapper, with inherited directory fds. Never fall back to overwriting rename.
const renameNoReplace = [
  "import ctypes, os, sys",
  "libc = ctypes.CDLL(None, use_errno=True)",
  "rename = libc.renameat2",
  "rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]",
  "rename.restype = ctypes.c_int",
  "if rename(3, os.fsencode(sys.argv[1]), 4, os.fsencode(sys.argv[2]), 1):",
  "    err = ctypes.get_errno()",
  "    raise OSError(err, os.strerror(err))"
].join('\n');
function createOwnedDirectory(dir) {
  const path = require('node:path');
  const parent = ownerFS.openSync(path.dirname(dir), ownerFlags);
  let staging, fd, name, created = false;
  try {
    const parentBase = '/proc/self/fd/' + parent;
    const stagingPath = parentBase + '/.cc-spawner-staging';
    try { ownerFS.mkdirSync(stagingPath, {mode:0o700}); }
    catch(e) { if(e.code !== 'EEXIST') throw e; }
    staging = ownerFS.openSync(stagingPath, ownerFlags);
    const ss = ownerFS.fstatSync(staging);
    if (ss.uid !== process.getuid() || (ss.mode & 0o7777) !== 0o700 ||
        ss.dev !== ownerFS.fstatSync(parent).dev)
      throw Error('Unsafe or cross-device private staging directory');
    const stagingBase = '/proc/self/fd/' + staging;
    name = require('node:crypto').randomBytes(32).toString('hex');
    const temporary = stagingBase + '/' + name;
    ownerFS.mkdirSync(temporary, {mode:0o700});
    created = true;
    fd = ownerFS.openSync(temporary, ownerFlags);
    const st = ownerFS.fstatSync(fd), base = '/proc/self/fd/' + fd;
    if (st.uid !== process.getuid() || st.dev !== ss.dev || ownerFS.readdirSync(base).length !== 0)
      throw Error('Unsafe staged directory');
    const nonce = require('node:crypto').randomBytes(32).toString('hex');
    const marker = ownerFS.openSync(base + '/.cc-spawner-owner',
      ownerFS.constants.O_WRONLY | ownerFS.constants.O_CREAT | ownerFS.constants.O_EXCL |
      ownerFS.constants.O_NOFOLLOW, 0o600);
    try { ownerFS.writeFileSync(marker, nonce); } finally { ownerFS.closeSync(marker); }
    ownerFS.fchmodSync(fd, 0o700);
    const identity = {dev:st.dev, ino:st.ino, nonce};
    if (!ownerMatches(fd, [identity])) throw Error('Staging attestation failed');
    require('node:child_process').execFileSync('python3', ['-c', renameNoReplace, name, path.basename(dir)],
      {stdio:['ignore', 'pipe', 'pipe', staging, parent]});
    const current = ownerFS.lstatSync(dir);
    if (current.isSymbolicLink() || current.dev !== st.dev || current.ino !== st.ino)
      throw Error('directory moved during publication');
    return identity;
  } finally {
    // Never remove the public path on failure: it may now belong to someone else.
    if (fd !== undefined) ownerFS.closeSync(fd);
    if (staging !== undefined) {
      try { if (created) ownerFS.rmSync('/proc/self/fd/' + staging + '/' + name, {recursive:true, force:true}); }
      finally { ownerFS.closeSync(staging); }
    }
    ownerFS.closeSync(parent);
  }
}
`;

export const PREPARE_HANDDIR_JS = DIRECTORY_OWNER_JS + String.raw`
let exists = false;
try { ownerFS.lstatSync(process.argv[1]); exists = true; }
catch(e) { if(e.code !== 'ENOENT') throw e; }
console.log(JSON.stringify(exists ? attestDirectory(process.argv[1], JSON.parse(process.argv[2])) :
  createOwnedDirectory(process.argv[1])));
`;
