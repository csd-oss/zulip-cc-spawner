import test from 'node:test';
import assert from 'node:assert/strict';
import { formatWorkdirSize } from '../src/workdir-size.js';

test('folder sizes use decimal MB, switching to GB at 1,000 MB', () => {
  for (const [bytes, expected] of [[0, '0 MB'], [840_000_000, '840 MB'], [999_000_000, '999 MB'], [1_000_000_000, '1 GB'], [1_234_000_000, '1.23 GB']] as const) {
    assert.equal(formatWorkdirSize({ bytes, partial: false }), expected);
  }
  assert.equal(formatWorkdirSize({ bytes: 840_009_999, partial: true }), '≥840 MB (partial/unknown)');
  assert.equal(formatWorkdirSize({ bytes: 0, partial: true }), '≥0 MB (partial/unknown)');
});
