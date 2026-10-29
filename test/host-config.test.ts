import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SudoHost } from '../src/host.js';
import { tmp } from './helpers.js';

/** A stand-in `sudo` that checks the exact flags SudoHost uses, then runs the command as us. */
function fakeSudo(): { dir: string; log: string } {
  const dir = tmp('ccsudo-');
  const log = join(dir, 'sudo.log');
  writeFileSync(
    join(dir, 'sudo'),
    `#!/bin/sh
[ "$1" = "-n" ] && [ "$2" = "-H" ] && [ "$3" = "-u" ] && [ "$5" = "--" ] || { echo "bad sudo flags: $*" >&2; exit 64; }
echo "$4 $6" >> "${log}"
shift 5
exec "$@"
`,
  );
  chmodSync(join(dir, 'sudo'), 0o755);
  return { dir, log };
}

test('SudoHost runs everything through sudo -n -H -u <user>, content via stdin', async () => {
  const { dir, log } = fakeSudo();
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    const h = new SudoHost('cc-agents');
    const work = tmp();
    const f = join(work, 'deep', 'dir', 'zuliprc');
    await h.writeFile(f, 'secret=1\n', 0o600);
    assert.equal(readFileSync(f, 'utf8'), 'secret=1\n');
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.equal(await h.exists(f), true);
    assert.equal(await h.exists(join(work, 'nope')), false);
    assert.equal(await h.size(f), 9);
    assert.equal(await h.size(join(work, 'nope')), undefined);
    assert.equal((await h.readFrom(f, 7)).toString(), '1\n');
    assert.equal((await h.readFrom(f, 9)).length, 0);
    await h.mkdirp(join(work, 'm'));
    assert.ok(existsSync(join(work, 'm')));
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, /^cc-agents sh$/m);
    assert.ok(!calls.includes('secret=1'), 'file content never appears on a command line');
  } finally {
    process.env.PATH = oldPath;
  }
});

test('config: template on first run, deny-all warnings, OS split enforced', async () => {
  const dir = tmp();
  const cfgPath = join(dir, 'config.json');
  process.env.CC_SPAWNER_CONFIG = cfgPath;
  const { loadConfig } = await import('../src/config.js');
  try {
    assert.throws(() => loadConfig(), /no zuliprc/);
    assert.ok(existsSync(cfgPath), 'template written');
    assert.equal(statSync(cfgPath).mode & 0o777, 0o600);
    writeFileSync(join(dir, 's.rc'), '[api]\nemail=a\nkey=b\nsite=https://x\n');
    const base = { spawnerRc: join(dir, 's.rc'), adminRc: join(dir, 's.rc') };
    writeFileSync(cfgPath, JSON.stringify(base));
    assert.throws(() => loadConfig(), /agentsUser is unset/);
    writeFileSync(cfgPath, JSON.stringify({ ...base, agentsUser: 'cc-agents', devMode: true }));
    assert.throws(() => loadConfig(), /not both/);
    writeFileSync(cfgPath, JSON.stringify({ ...base, agentsUser: 'cc-agents' }));
    process.env.CC_SPAWNER_INACTIVITY_MS = '5000';
    const cfg = loadConfig();
    assert.equal(cfg.inactivityMs, 5000);
    assert.deepEqual(cfg.attributionHeaders, {});
    process.env.CC_SPAWNER_INACTIVITY_MS = 'soon';
    assert.throws(() => loadConfig(), /bad CC_SPAWNER_INACTIVITY_MS/);
  } finally {
    delete process.env.CC_SPAWNER_CONFIG;
    delete process.env.CC_SPAWNER_INACTIVITY_MS;
  }
});
