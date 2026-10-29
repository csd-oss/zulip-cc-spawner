import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAnswerSpec, parseDialogPane } from '../src/question.js';

// Shapes from upstream's verified TUI notes (claude 2.1.241 / 2.1.258).
const ASK = [
  '──────────────────────────────────────────',
  ' ☐ Fruit',
  '',
  'Which fruit should I use?',
  '',
  '❯ 1. Apple',
  '     Crunchy',
  '  2. Banana',
  '  3. Type something.',
  '  4. Chat about this',
].join('\n');

const PERMISSION = [
  '────────────────────────────────────────────',
  ' Bash command',
  '',
  '   │ rm -rf "$DIR/build"',
  '',
  ' Dangerous rm operation on possibly-empty variable path',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');

test('AskUserQuestion dialog is parsed with its free-text entry', () => {
  const d = parseDialogPane(ASK);
  assert.equal(d.kind, 'question');
  if (d.kind !== 'question') return;
  assert.equal(d.q.question, 'Which fruit should I use?');
  assert.deepEqual(d.q.options.map((o) => o.label), ['Apple', 'Banana']);
  assert.equal(d.q.textOptionIndex, 3);
  assert.equal(parseAnswerSpec('2', d.q).kind, 'digits');
  assert.deepEqual(parseAnswerSpec('mango please', d.q), { kind: 'text', text: 'mango please' });
});

test('permission prompt is parsed; yes/no map to options', () => {
  const d = parseDialogPane(PERMISSION);
  assert.equal(d.kind, 'question');
  if (d.kind !== 'question') return;
  assert.equal(d.q.kind, 'permission');
  assert.equal(d.q.title, 'Bash command');
  assert.match(d.q.detail!, /rm -rf/);
  assert.deepEqual(parseAnswerSpec('yes', d.q), { kind: 'digits', nums: [1] });
  assert.deepEqual(parseAnswerSpec('deny', d.q), { kind: 'digits', nums: [2] });
  assert.equal(parseAnswerSpec('maybe', d.q).kind, 'error');
});

test('an ordinary screen is no dialog', () => {
  assert.equal(parseDialogPane('> hello\n  ? for shortcuts').kind, 'none');
});
