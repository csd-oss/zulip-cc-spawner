import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SpawnerActions } from '../src/actions.js';
import { parseCommand } from '../src/commands.js';
import { HAND_PROCESSES_JS } from '../src/delete-hand.js';
import { LocalHost } from '../src/host.js';
import { Registry, type BotEntry } from '../src/registry.js';
import { PREPARE_WORKDIR_JS } from '../src/workdir.js';
import { testConfig, tmp } from './helpers.js';

// Real-filesystem revival of pre-attestation hands (TASK-WP4ZR). A legacy
// record is modelled by stripping identities AND the on-disk markers: hands
// created before 8cef78a never had either.
function fixture() {
  const dir = tmp('legacy-revive-'), config = testConfig(dir, { ownerUserId: 1 });
  mkdirSync(config.handsDir, { recursive: true }); mkdirSync(join(dir, 'hands'));
  const registry = new Registry(join(dir, 'registry.json')), local = new LocalHost(), host = new LocalHost();
  const adoptCalls: string[] = [];
  host.exec = async (cmd, args, opts) => {
    if (args[1] === HAND_PROCESSES_JS) return { stdout: 'false' };
    if (args[1] === PREPARE_WORKDIR_JS && args[4] === 'adopt-legacy') adoptCalls.push(args[2]);
    return local.exec(cmd, args, opts);
  };
  const sessions = new Set<string>();
  const tmux = { otherPaneRoots: async () => [], hasSession: async (s: string) => sessions.has(s), killSession: async (s: string) => sessions.delete(s) };
  const provisioner = { ensure: async (_full: string, short: string) => ({ bot: { userId: 100, email: short + '@offline' }, created: true }), subscribe: async () => {}, rename: async () => {}, deactivate: async () => {}, credsFor: () => ({ email: 'fake@offline', key: 'fake', site: 'https://offline' }) };
  const launcher = { launch: async (r: { tmuxSession: string }) => { sessions.add(r.tmuxSession); return {}; } };
  const watcher = { transcriptPath: (id: string) => join(dir, 'transcripts', id) };
  const actions = new SpawnerActions({ config, registry, host, tmux, provisioner, launcher, watcher, notifier: {}, groupCheck: async () => false, realm: 'offline' } as any);
  const run = async (body: string, topic = 't') => (await actions.run({ body, cmd: parseCommand(body), where: { kind: 'stream', streamName: 'cc-hands', streamId: 7, topic }, invoker: { kind: 'user', userId: 1, name: 'Tester' } })).content;
  return { dir, config, registry, actions, run, adoptCalls, workRoot: join(dir, 'hands') };
}

/** A stopped hand exactly as a pre-attestation spawner left it. */
async function legacyHand(f: ReturnType<typeof fixture>, name = 'old'): Promise<BotEntry> {
  assert.match(await f.run(`spawn opus-5-5 name=${name}`), /Spawned/);
  await f.run(`stop ${name}`);
  const e = f.registry.all().at(-1)!;
  delete e.handDirIdentity; delete e.workDirIdentity; e.handDirReady = true; e.workDirReady = true;
  f.registry.save();
  for (const p of [e.handDir, e.workDir!]) rmSync(join(p, '.cc-spawner-owner'));
  writeFileSync(join(e.workDir!, 'precious'), 'legacy work');
  return e;
}

const marker = (dir: string) => readFileSync(join(dir, '.cc-spawner-owner'), 'utf8');

test('legacy hand revives: workDir adopted, adoption recorded apart from creation identity', async () => {
  const f = fixture(), e = await legacyHand(f);
  assert.equal(e.workDir, join(f.workRoot, e.tmuxSession));
  const inode = lstatSync(e.workDir!).ino;
  assert.match(await f.run('spawn opus-5-5 name=old'), /Spawned|Revived/);
  const revived = f.registry.all().at(-1)!;
  assert.equal(revived.status, 'alive');
  assert.equal(revived.tmuxSession, e.tmuxSession); assert.equal(revived.workDir, e.workDir);
  assert.equal(revived.workDirReady, true);
  assert.equal(revived.workDirIdentity, undefined, 'never a creation attestation');
  assert.equal(revived.workDirAdoption?.ino, inode);
  assert.equal(revived.workDirAdoption?.nonce, marker(e.workDir!));
  assert.equal(statSync(join(e.workDir!, '.cc-spawner-owner')).mode & 0o777, 0o600);
  assert.equal(statSync(e.workDir!).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(e.workDir!, 'precious'), 'utf8'), 'legacy work');
  // handDir stays explicitly unproven (unchanged legacy behaviour).
  assert.equal(revived.handDirIdentity, undefined); assert.equal(revived.handDirReady, false);
  // Claude trust is prepared exactly as for any revival.
  assert.equal(JSON.parse(readFileSync(join(f.config.agentsHome, '.claude.json'), 'utf8')).projects[e.workDir!].hasTrustDialogAccepted, true);

  // Later revivals attest the adoption marker; no second adoption.
  await f.run('stop old');
  assert.match(await f.run('spawn opus-5-5 name=old'), /Spawned|Revived/);
  const again = f.registry.all().at(-1)!;
  assert.deepEqual(again.workDirAdoption, revived.workDirAdoption);
  assert.equal(again.workDirIdentity, undefined);
  assert.deepEqual(f.adoptCalls, [e.workDir]);
});

test('revival after a refused pre-fix attempt still finds the legacy record', async () => {
  const f = fixture(), e = await legacyHand(f);
  // What 85579bed left behind: a failed entry that never reached preparation.
  f.registry.add({ ...e, status: 'failed', workDirReady: undefined, handDirReady: false, endReason: 'spawn failed: Workspace already exists' });
  assert.match(await f.run('spawn opus-5-5 name=old'), /Spawned|Revived/);
  assert.equal(f.registry.all().at(-1)!.workDirAdoption?.nonce, marker(e.workDir!));
});

test('ordinary delete after adoption keeps the workDir (legacy semantics)', async () => {
  const f = fixture(), e = await legacyHand(f);
  await f.run('spawn opus-5-5 name=old'); await f.run('stop old');
  const dry = await f.run('delete old');
  assert.match(dry, new RegExp(`workDir: ${JSON.stringify(e.workDir).replace(/[\\/.*+?^${}()|[\]]/g, '\\$&')} \\(kept: not created by this hand\\)`));
  assert.match(await f.run('delete old confirm'), /Deleted/);
  assert.equal(readFileSync(join(e.workDir!, 'precious'), 'utf8'), 'legacy work');
  assert.equal(existsSync(join(e.workDir!, '.cc-spawner-owner')), true);
});

test('force-legacy after adoption: still available, same exact-path removal, nothing extra', async () => {
  const f = fixture(), e = await legacyHand(f);
  await f.run('spawn opus-5-5 name=old'); await f.run('stop old');
  const preview = await f.run('delete old force-legacy');
  assert.match(preview, /Force-legacy preview/);
  assert.match(preview, /workDir: .*\(remove directory and contents\)/);
  const command = preview.match(/delete \S+ confirm force-legacy [a-f0-9]+/)![0];
  assert.match(await f.run(command), /Deleted/);
  assert.equal(existsSync(e.workDir!), false); assert.equal(existsSync(e.handDir), false);
});

test('swapped folder after adoption is refused, not re-adopted', async () => {
  const f = fixture(), e = await legacyHand(f);
  await f.run('spawn opus-5-5 name=old'); await f.run('stop old');
  renameSync(e.workDir!, e.workDir! + '.retired'); mkdirSync(e.workDir!);
  writeFileSync(join(e.workDir!, 'precious'), 'foreign replacement');
  assert.match(await f.run('spawn opus-5-5 name=old'), /Refusing to adopt/);
  assert.equal(existsSync(join(e.workDir!, '.cc-spawner-owner')), false);
  assert.equal(f.adoptCalls.length, 1);
});

test('no registry history: existing folder at the new hand path is refused', async () => {
  const f = fixture(), p = join(f.workRoot, 'cc-scout');
  mkdirSync(p); writeFileSync(join(p, 'precious'), 'foreign');
  assert.match(await f.run('spawn opus-5-5 name=scout'), /Refusing to adopt/);
  assert.equal(existsSync(join(p, '.cc-spawner-owner')), false);
  assert.deepEqual(f.adoptCalls, []);
});

test('legacy record for a different workDir does not authorize the revived path', async () => {
  const f = fixture(), e = await legacyHand(f);
  const other = join(f.workRoot, 'other-folder');
  mkdirSync(other); writeFileSync(join(other, 'precious'), 'foreign');
  // Latest record points at another (existing) path that was never prepared.
  f.registry.add({ ...e, workDir: other, workDirReady: undefined, status: 'failed' });
  assert.match(await f.run('spawn opus-5-5 name=old'), /Refusing to adopt/);
  for (const p of [other, e.workDir!]) assert.equal(existsSync(join(p, '.cc-spawner-owner')), false);
  assert.deepEqual(f.adoptCalls, []);
});

test('legacy workDir outside <workRoot>/<tmux-name> is refused', async () => {
  const f = fixture(), e = await legacyHand(f);
  const elsewhere = join(f.dir, 'elsewhere', e.tmuxSession);
  mkdirSync(join(f.dir, 'elsewhere')); renameSync(e.workDir!, elsewhere);
  for (const r of f.registry.all()) r.workDir = elsewhere;
  f.registry.save();
  assert.match(await f.run('spawn opus-5-5 name=old'), /Refusing to adopt it: a pre-attestation workspace is adopted only at/);
  assert.equal(existsSync(join(elsewhere, '.cc-spawner-owner')), false);
});

test('legacy workDir that is a symlink is refused', async () => {
  const f = fixture(), e = await legacyHand(f);
  const target = join(f.dir, 'link-target');
  renameSync(e.workDir!, target); symlinkSync(target, e.workDir!);
  assert.match(await f.run('spawn opus-5-5 name=old'), /Refusing to adopt it\. .*symlink refused/);
  assert.equal(existsSync(join(target, '.cc-spawner-owner')), false);
});

test('legacy workDir already carrying a marker (another attested folder) is refused', async () => {
  const f = fixture(), e = await legacyHand(f);
  writeFileSync(join(e.workDir!, '.cc-spawner-owner'), 'f'.repeat(64));
  assert.match(await f.run('spawn opus-5-5 name=old'), /already carries an ownership marker/);
  assert.equal(marker(e.workDir!), 'f'.repeat(64));
});

for (const shape of ['same', 'inside', 'contains'] as const)
test('legacy workDir shared with another hand is refused: ' + shape, async () => {
  const f = fixture(), e = await legacyHand(f);
  const shared = shape === 'same' ? e.workDir! : shape === 'inside' ? join(e.workDir!, 'sub') : f.workRoot;
  f.registry.add({ ...e, tmuxSession: 'cc-neighbour', suffix: 'neighbour', personaName: 'Neighbour', botUserId: 200, handDir: join(f.config.handsDir, 'cc-neighbour'), workDir: shared });
  assert.match(await f.run('spawn opus-5-5 name=old'), /Refusing to adopt it: directory shared with another hand/);
  assert.equal(existsSync(join(e.workDir!, '.cc-spawner-owner')), false);
  assert.deepEqual(f.adoptCalls, []);
});

// Helper-level checks the daemon cannot bypass (canonical paths and inodes).
function adopt(dir: string, opts: object): string {
  try {
    return execFileSync(process.execPath, ['-e', PREPARE_WORKDIR_JS, dir, join(dir, '..', 'claude.json'), 'adopt-legacy', 'no-trust', 'null', JSON.stringify(opts)], { stdio: 'pipe' }).toString();
  } catch (err) { return 'ERR ' + String((err as { stderr?: Buffer }).stderr); }
}

test('adoption helper refuses roots, overlaps, aliases and wrong names', () => {
  const root = tmp('adopt-helper-'), p = join(root, 'cc-x');
  mkdirSync(p);
  const base = { root, name: 'cc-x', roots: [], references: [] };
  assert.match(adopt(p, { ...base, name: 'cc-y' }), /not this hand directory/);
  assert.match(adopt(p, { ...base, roots: [p] }), /configured root refused/);
  assert.match(adopt(p, { ...base, roots: [join(p, 'nested-root')] }), /configured root refused/);
  assert.match(adopt(p, { ...base, references: [join(p, 'child')] }), /directory shared with another hand/);
  // A canonical alias through a symlink elsewhere still names the same directory.
  const alias = join(root, 'alias'); symlinkSync(p, alias);
  assert.match(adopt(p, { ...base, references: [alias] }), /directory shared with another hand/);
  assert.match(adopt(`${root}/../${root.split('/').at(-1)}/cc-x`, base), /not this hand directory/);
  assert.equal(existsSync(join(p, '.cc-spawner-owner')), false);
  const identity = JSON.parse(adopt(p, base));
  assert.equal(identity.nonce, marker(p)); assert.equal(identity.ino, lstatSync(p).ino);
  assert.match(adopt(p, base), /already carries an ownership marker/);
});

test('missing legacy handDir: fresh handDir attested, force-legacy refused, workDir kept', async () => {
  const f = fixture(), e = await legacyHand(f);
  rmSync(e.handDir, { recursive: true });
  assert.match(await f.run('spawn opus-5-5 name=old'), /Spawned|Revived/);
  const revived = f.registry.all().at(-1)!;
  assert.ok(revived.handDirIdentity?.nonce); assert.ok(revived.workDirAdoption?.nonce);
  await f.run('stop old');
  assert.match(await f.run('delete old force-legacy'), /only for pre-attestation hands/);
  assert.match(await f.run('delete old confirm'), /Deleted/);
  assert.equal(existsSync(e.handDir), false);
  assert.equal(readFileSync(join(e.workDir!, 'precious'), 'utf8'), 'legacy work');
});

test('trust failure after adoption retracts the marker; a later revival adopts', async () => {
  const f = fixture(), e = await legacyHand(f);
  const claudeJson = join(f.config.agentsHome, '.claude.json');
  const good = readFileSync(claudeJson, 'utf8');
  writeFileSync(claudeJson, 'broken');
  assert.match(await f.run('spawn opus-5-5 name=old'), /failed/);
  assert.equal(existsSync(join(e.workDir!, '.cc-spawner-owner')), false);
  assert.equal(f.registry.all().at(-1)!.workDirAdoption, undefined);
  writeFileSync(claudeJson, good);
  assert.match(await f.run('spawn opus-5-5 name=old'), /Spawned|Revived/);
  assert.equal(f.registry.all().at(-1)!.workDirAdoption?.nonce, marker(e.workDir!));
  assert.equal(f.adoptCalls.length, 2);
});

test('refused adoption leaves folder permissions untouched', async () => {
  const f = fixture(), e = await legacyHand(f);
  writeFileSync(join(e.workDir!, '.cc-spawner-owner'), 'f'.repeat(64));
  chmodSync(e.workDir!, 0o750);
  assert.match(await f.run('spawn opus-5-5 name=old'), /Refusing to adopt/);
  assert.equal(statSync(e.workDir!).mode & 0o777, 0o750);
});
