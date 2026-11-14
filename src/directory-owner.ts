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
function attestDirectory(dir, created, old) {
  const fd = ownerFS.openSync(dir, ownerFlags);
  try {
    const st = ownerFS.fstatSync(fd), base = '/proc/self/fd/' + fd;
    if (!created) return ownerMatches(fd, [old].filter(Boolean)) ? old : null;
    if (st.uid !== process.getuid() || ownerFS.readdirSync(base).length !== 0)
      throw Error('Refusing to adopt nonempty or foreign-owned directory: ' + dir);
    const nonce = require('node:crypto').randomBytes(32).toString('hex');
    const marker = ownerFS.openSync(base + '/.cc-spawner-owner',
      ownerFS.constants.O_WRONLY | ownerFS.constants.O_CREAT | ownerFS.constants.O_EXCL |
      ownerFS.constants.O_NOFOLLOW, 0o600);
    try { ownerFS.writeFileSync(marker, nonce); } finally { ownerFS.closeSync(marker); }
    ownerFS.fchmodSync(fd, 0o700);
    const current = ownerFS.lstatSync(dir);
    if (current.isSymbolicLink() || current.dev !== st.dev || current.ino !== st.ino)
      throw Error('directory moved during attestation');
    return {dev:st.dev, ino:st.ino, nonce};
  } finally { ownerFS.closeSync(fd); }
}
`;

export const PREPARE_HANDDIR_JS = DIRECTORY_OWNER_JS + String.raw`
const fs=require('node:fs'); let created=false;
try { fs.mkdirSync(process.argv[1], {mode:0o700}); created=true; }
catch(e) { if(e.code!=='EEXIST') throw e; }
console.log(JSON.stringify(attestDirectory(process.argv[1], created, JSON.parse(process.argv[2]))));
`;
