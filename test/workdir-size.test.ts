import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalHost } from '../src/host.js';
import { workdirSizes } from '../src/workdir-size.js';
import { testConfig, tmp } from './helpers.js';

test('sizes count hidden files, deduplicate hardlinks, skip symlinks and reject linked ancestors', async () => {
  const dir = tmp(); const root = join(dir, 'work'); mkdirSync(root);
  writeFileSync(join(root, '.hidden'), '12345'); linkSync(join(root, '.hidden'), join(root, 'hard'));
  symlinkSync('/proc', join(root, 'link'));
  symlinkSync(root, join(dir, 'alias'));
  const result = await workdirSizes(new LocalHost(), testConfig(dir), [root, root, join(dir, 'alias'), join(dir, 'absent')]);
  assert.deepEqual(result.slice(0, 2), [{ bytes: 5, partial: false }, { bytes: 5, partial: false }]);
  assert.deepEqual(result.slice(2), [{ bytes: 0, partial: true }, { bytes: 0, partial: true }]);
});

test('unreadable entries produce partial sizes, not a failed list', async () => {
  const dir = tmp(); const root = join(dir, 'work'); mkdirSync(root);
  writeFileSync(join(root, 'file'), '123'); const blocked = join(root, 'blocked'); mkdirSync(blocked); chmodSync(blocked, 0);
  try {
    const [result] = await workdirSizes(new LocalHost(), testConfig(dir), [root]);
    assert.equal(result.bytes, 3);
    if (process.getuid!() !== 0) assert.equal(result.partial, true);
  } finally { chmodSync(blocked, 0o700); }
});

test('large trees have bounded partial results', async () => {
  const dir = tmp(); const root = join(dir, 'large'); mkdirSync(root);
  for (let i = 0; i < 10020; i++) writeFileSync(join(root, String(i)), 'x');
  const start = Date.now();
  const [result] = await workdirSizes(new LocalHost(), testConfig(dir), [root]);
  assert.equal(result.partial, true); assert.ok(result.bytes <= 10000); assert.ok(Date.now() - start < 5000);
});

test('size overflow saturates only the affected path and preserves healthy rows', async () => {
  const dir = tmp(); const huge = join(dir, 'huge'); const small = join(dir, 'small');
  mkdirSync(huge); mkdirSync(small);
  writeFileSync(join(huge, 'a'), 'a'); writeFileSync(join(huge, 'b'), 'b');
  writeFileSync(join(small, 'healthy'), '12345');
  // Inject oversized stat values into the real worker traversal, avoiding
  // filesystem-dependent sparse-file limits and scan deadlines.
  const local = new LocalHost();
  const host = { exec: (cmd: string, args: string[]) => local.exec(cmd,
    args.map((arg, i) => i === 1 ? arg.replace('if (st.isFile()) {',
      "if (st.isFile()) { if (ent.name === 'a' || ent.name === 'b') st.size = Number.MAX_SAFE_INTEGER;") : arg)) };
  const result = await workdirSizes(host as LocalHost, testConfig(dir), [huge, small]);
  assert.deepEqual(result, [
    { bytes: Number.MAX_SAFE_INTEGER, partial: true }, { bytes: 5, partial: false },
  ]);
});
