import assert from 'node:assert/strict';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { HAND_PROCESSES_JS } from '../src/delete-hand.js';
const entries = [{handDir: '/hands/target'}];

// Snapshot of the reviewer forgery: names/cgroups are deliberately not trusted.
export function managerSnapshot(overrides: {childStart: string; parentStart: string}) {
  let output = '';
  const fs = {
    statSync: () => ({uid: 123}), readdirSync: () => ['20'],
    readFileSync(p: string) {
      const field = p.split('/').at(-1);
      const parent = p.startsWith('/proc/10/');
      if (field === 'cmdline') return 'unrelated\0';
      if (field === 'environ') throw Object.assign(Error('PRIVATE'), {code: 'EACCES'});
      if (field === 'status') return 'Uid:\t123 123 123 123\nDumpable:\t0\n';
      if (field === 'cgroup') return '0::/user.slice/user-123.slice/user@123.service/init.scope\n';
      if (field === 'comm') return parent ? 'systemd\n' : '(sd-pam)\n';
      if (field === 'stat') {
        const fields = Array(20).fill('0'); fields[0] = 'S'; fields[1] = parent ? '1' : '10';
        fields[19] = parent ? overrides.parentStart : overrides.childStart;
        return (parent ? '10 (systemd) ' : '20 ((sd-pam)) ') + fields.join(' ');
      }
      throw Error('unexpected fixture read');
    },
    readlinkSync: () => '/unrelated',
  };
  runInNewContext(HAND_PROCESSES_JS, {require: (n: string) => {
    if (n === 'node:fs') return fs;
    assert.equal(n, 'node:path'); // No subprocess/getconf dependency.
    return path;
  },
    process: {pid: 999, argv: ['node', JSON.stringify(entries)]}, console: {log: (s: string) => {output = s;}}});
  assert.doesNotMatch(output, /PRIVATE|user\.slice|init\.scope|sd-pam/);
  return JSON.parse(output);
}
