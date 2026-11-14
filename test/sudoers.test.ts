import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('sudoers limits session defaults and the one-way rule to cc-spawner', () => {
  const lines = readFileSync(new URL('../deploy/sudoers-cc-spawner', import.meta.url), 'utf8')
    .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  assert.deepEqual(lines, [
    'Defaults:cc-spawner !requiretty',
    'Defaults:cc-spawner !pam_session',
    'cc-spawner ALL=(cc-agents) NOPASSWD: ALL',
  ]);
});
