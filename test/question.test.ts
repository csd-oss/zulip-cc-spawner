import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  captureText, dialogSig, expiryAllows, formatQuestionPosts, openToolUses, parseAnswerSpec, parseDialogPane, requestKey, sameDialog, stampExpiry,
  type OpenToolUse, type PendingQ,
} from '../src/question.js';
import type { BotEntry } from '../src/registry.js';

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

const fixture = (name: string) => readFileSync(new URL(`./fixtures/claude-2.1.323/${name}.txt`, import.meta.url), 'utf8');
const BOXED = fixture('permission-countdown-tick0');
const BOXED_COMMAND = 'rm -rf "$(printf %s /tmp/task-40kjf-fixture1/nonexistent)"';
/** The description every probe's Bash call carries, and the dialog shows under its title. */
const PROBE = 'Local scratch-only permission prompt probe';
const bash = (command: string, id = 'toolu_1', description: string | null = PROBE): OpenToolUse =>
  ({ id, name: 'Bash', input: { command, ...(description ? { description } : {}) } });

/** Real pane + the session's transcript lines at the same moment (fixtures/dialogs/README.txt). */
const live = (name: string) => readFileSync(new URL(`./fixtures/dialogs/${name}`, import.meta.url), 'utf8');
const pending = (name: string) => openToolUses(live(`${name}.jsonl`));

function permission(pane: string, open: OpenToolUse[] = []) {
  const d = parseDialogPane(pane, open);
  assert.equal(d.kind, 'question');
  assert.equal(d.q.kind, 'permission');
  return d.q;
}

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
  assert.equal(d.q.requiresTerminal, undefined);
  assert.deepEqual(parseAnswerSpec('yes', d.q), { kind: 'digits', nums: [1] });
  assert.deepEqual(parseAnswerSpec('deny', d.q), { kind: 'digits', nums: [2] });
  assert.equal(parseAnswerSpec('maybe', d.q).kind, 'error');
});

// ── A pending tool_use, once it is the only one that fits the dialog, is the identity ──

test('pending tool_uses are read from the transcript in order; results and sidechains drop out', () => {
  assert.deepEqual(pending('parallel-2.1.323.transcript-open').map((u) => u.id), ['toolu_main0', 'toolu_main1']);
  assert.deepEqual(pending('parallel-2.1.323.transcript-after1').map((u) => u.id), ['toolu_main1']);
  assert.deepEqual(pending('subagent-2.1.323.transcript'), []); // the Agent call returned; the subagent's Bash is not in this file
  const line = live('heredoc6-2.1.323.transcript.jsonl').trimEnd().split('\n').at(-1)!;
  assert.deepEqual(openToolUses(line.replace('"isSidechain":false', '"isSidechain":true')), []);
  assert.deepEqual(openToolUses(line.slice(0, -40)), []); // a line still being written
  assert.deepEqual(openToolUses('not json\n\n{"type":"assistant"}\n'), []);
});

// `styled`: captured with attributes (capture-pane -e), as the watcher does.
// heredoc6 has the rule off screen and the title as its first row: only the
// title's attributes prove that row is the title, so the plain capture of the
// very same screen is for the terminal.
for (const [name, capture, ticks, words, top] of [
  ['heredoc6-2.1.323', 'styled', ['tick0', 'tick1', 'tick2'], 'block', 'title'],
  ['heredoc6-2.1.306', 'styled', ['tick0', 'tick1', 'tick2'], 'deny', 'title'],
  ['heredoc6-2.1.323', 'pane', ['tick0', 'tick1', 'tick2'], 'block', 'title unproven'],
  ['heredoc6-2.1.306', 'pane', ['tick0', 'tick1', 'tick2'], 'deny', 'title unproven'],
  ['heredoc400-2.1.323', 'pane', ['tick0', 'tick2'], 'block', 'off screen'],
  ['heredoc400-2.1.306', 'pane', ['tick0', 'tick2'], 'deny', 'off screen'],
  ['narrow26-2.1.323', 'pane', ['tick0', 'tick2'], 'block', 'rule'],
  ['wrapped40-2.1.323', 'pane', ['tick0'], 'block', 'title off screen'], // the pane starts on the description's second row
  ['barewrap38-2.1.323', 'pane', ['tick0', 'tick2'], 'block', 'rule'],
  ['tabs-2.1.323', 'pane', ['tick0'], 'block', 'rule'],
  ['lookalike-2.1.323', 'pane', ['tick0'], 'block', 'rule'],
] as const) {
  test(`a live Bash prompt is tied to the one pending tool_use it displays, through the ticks (${name}, ${capture}: ${top})`, () => {
    const open = pending(`${name}.transcript`);
    assert.equal(open.length, 1);
    const qs = ticks.map((tick) => permission(live(`${name}.${capture}-${tick}.txt`), open));
    for (const [i, q] of qs.entries()) {
      const pane = captureText(live(`${name}.${capture}-${ticks[i]}.txt`));
      assert.equal(q.toolUseId, 'toolu_main0');
      // The identity rows run from the title (or the top of the pane) to the box's bottom border…
      assert.ok(pane.includes(`${q.shown!}\n`));
      assert.match(q.shown!, /nonexistent\)"\n╌+$/);
      assert.equal(/automatically|Dangerous rm/.test(q.shown!), false);
      // …while what is posted is everything the terminal shows — reason and countdown included.
      assert.match(q.detail!.replace(/\s+/g, ' '), new RegExp(`Dangerous rm operation .* Claude Code will automatically ${words} this request in 1:5\\d, to avoid`));
      assert.deepEqual(q.options.map((o) => o.label), ['Yes', 'No']);
      if (top !== 'title' && top !== 'rule') {
        // The pane starts inside the box, or under the title, or at a row
        // nothing proves to be the title: the request, or whose it is, cannot
        // be shown, so the tie only keeps the prompt from being reposted.
        assert.equal(q.terminalWhy, 'cut');
        assert.equal(q.requiresTerminal, true);
        assert.equal(q.title, 'Permission request');
      } else {
        assert.equal(q.requiresTerminal, undefined);
        assert.equal(q.title, 'Bash command');
        assert.match(q.shown!, /^ Bash command\n/);
        // The title row is not repeated in the quoted rows, rule on screen or not.
        assert.equal(q.detail!.startsWith(' Bash command'), false);
      }
      // Nothing of the transcript is in the parsed prompt but the id.
      assert.deepEqual(Object.keys(q).filter((k) => /command|input/.test(k)), []);
    }
    assert.equal(new Set(qs.map(dialogSig)).size, 1);
    // By the rows alone (no transcript) it is one prompt through the ticks as
    // well — one post — and it takes no answer: under a countdown, rows that
    // read the same are not proof of the same request (TASK-BYSTH round 2;
    // PR #17 had such a prompt differ from second to second, a post per tick).
    const untied = ticks.map((tick) => permission(live(`${name}.${capture}-${tick}.txt`)));
    assert.equal(new Set(untied.map(dialogSig)).size, 1);
    for (const q of untied) assert.equal(q.terminalWhy, top === 'title' || top === 'rule' ? 'unbound' : 'cut');
    // The notice is read as what it is — its rows of the detail, its clock —
    // and its clock runs down from tick to tick.
    const clocks = untied.map((q) => q.expiry!.seconds!);
    for (const [i, q] of untied.entries()) {
      const [from, to] = q.expiry!.rows;
      assert.match(q.detail!.split('\n').slice(from, to).join(' ').replace(/\s+/g, ' '), new RegExp(`^ ⚠ Claude Code will automatically ${words} this request in ${q.expiry!.clock}, to avoid .* an unattended session$`));
      assert.equal(q.expiry!.clock, `1:${clocks[i] - 60}`);
      if (i > 0) assert.ok(clocks[i] < clocks[i - 1]);
    }
  });
}

test('the box must show the pending command itself: any other command leaves the prompt untied', () => {
  for (const [name, command] of [
    ['heredoc6-2.1.323', pending('heredoc6-2.1.323.transcript')[0].input.command as string],
    ['wrapped40-2.1.323', pending('wrapped40-2.1.323.transcript')[0].input.command as string],
    ['tabs-2.1.323', pending('tabs-2.1.323.transcript')[0].input.command as string],
  ] as const) {
    const pane = live(`${name}.pane-tick0.txt`);
    assert.equal(permission(pane, [bash(command)]).toolUseId, 'toolu_1');
    for (const other of [
      command.replace('nonexistent', 'nonexistenu'),
      command.replace('rm -rf', 'rm -r -f'),
      command.replace('rm -rf', 'rm-rf'), // whitespace inside a line is not a line break
      `true; ${command}`,
      `${command}; true`,
      command.replace(/\n/, '\nextra\n'),
      command.slice(1),
    ]) {
      if (other === command) continue; // no newline to split in a one-line command
      const q = permission(pane, [bash(other)]);
      assert.equal(q.toolUseId, undefined, other.slice(0, 60));
      assert.match(q.detail!, /1:5\d/); // untied: every row stays in the identity
    }
    // Not a Bash call, or no command at all.
    assert.equal(permission(pane, [{ id: 'x', name: 'Write', input: { command, description: PROBE } }]).toolUseId, undefined);
    assert.equal(permission(pane, [{ id: 'x', name: 'Bash', input: { description: PROBE } }]).toolUseId, undefined);
    // The description under the title is part of the request shown: another one is another call.
    assert.equal(permission(pane, [bash(command, 'x', 'Some other description')]).toolUseId, undefined);
    assert.equal(permission(pane, [bash(command, 'x', `${PROBE} too`)]).toolUseId, undefined);
    assert.equal(permission(pane, [bash(command, 'x', null)]).toolUseId, undefined);
  }
});

test('a call without a description is shown with the default one; a long one wraps into a gutter', () => {
  for (const version of ['2.1.323', '2.1.306']) {
    const none = pending(`nodesc-${version}.transcript`);
    assert.equal(none[0].input.description, undefined);
    const pane = live(`nodesc-${version}.pane-open.txt`);
    assert.match(pane, /\n Bash command\n Run shell command\n╌/);
    assert.equal(permission(pane, none).toolUseId, 'toolu_main0');
    assert.equal(permission(pane, [bash('printf reviewer', 'x', 'Print a word')]).toolUseId, undefined);

    const long = pending(`longdesc-${version}.transcript`);
    assert.ok((long[0].input.description as string).length > 400);
    const wrapped = permission(live(`longdesc-${version}.pane-open.txt`), long);
    assert.match(wrapped.shown!, /^ Bash command\n │ Print a word and another word 0 [\s\S]*\n │ 29\n╌+\n printf reviewer\n╌+$/);
    assert.equal(wrapped.toolUseId, 'toolu_main0');
    assert.equal(wrapped.requiresTerminal, undefined);
    const other = { ...long[0], input: { ...long[0].input, description: (long[0].input.description as string).replace('word 17', 'word 71') } };
    assert.equal(permission(live(`longdesc-${version}.pane-open.txt`), [other]).toolUseId, undefined);
  }
});

test('with the top of the box off screen the prompt is terminal-only; the tie is only a hint against reposting', () => {
  const pane = live('heredoc400-2.1.323.pane-tick0.txt');
  const command = pending('heredoc400-2.1.323.transcript')[0].input.command as string;
  const tied = permission(pane, [bash(command)]);
  assert.equal(tied.toolUseId, 'toolu_1');
  assert.equal(tied.terminalWhy, 'cut');
  // The hint is still a match of what IS on screen: the visible rows must be the command's tail.
  for (const other of [
    command.replace('scratch line 399', 'scratch line 39x'), // differs in a visible row
    command.replace('nonexistent', 'nonexistenu'),
    `${command}\ntrue`,
    command.replace(/\nEND\n/, '\nEND\n\nextra\n'),
  ]) {
    const q = permission(pane, [bash(other)]);
    assert.equal(q.toolUseId, undefined, other.slice(-60));
    assert.equal(q.terminalWhy, 'cut'); // tied or not, by the pane alone
  }
  assert.equal(permission(pane).terminalWhy, 'cut');
  // Rows above the pane cannot be checked against anything on screen. A call
  // that differs only up there ties just the same — which is why the tie
  // authorises nothing here, and why none of the call's text reaches the post.
  const above = permission(pane, [bash(command.replace('scratch line 0\n', 'scratch line zero\n'))]);
  assert.equal(above.toolUseId, 'toolu_1');
  assert.equal(above.terminalWhy, 'cut');
  assert.equal(JSON.stringify(above).includes('scratch line zero'), false);
  assert.equal(JSON.stringify(tied).includes('scratch line 0\\n'), false);
  // Two pending calls with this tail: not even a hint for one of them.
  const two = permission(pane, [bash(command, 'a'), bash(command.replace('scratch line 0\n', 'scratch line zero\n'), 'b')]);
  assert.equal(two.toolUseId, undefined);
  assert.deepEqual(two.lookalikes, ['a', 'b']);
  assert.equal(two.requiresTerminal, true);
  // A visible title is not a scrolled-off box.
  assert.equal(permission(`──────────\n Bash command\n${pane}`, [bash(command)]).toolUseId, undefined);
});

test('title off screen but the whole box on it: tied as a hint, answered in the terminal', () => {
  // 38x30, a description of nine wrapped rows: the pane starts inside it.
  for (const version of ['2.1.323', '2.1.306']) {
    const pane = live(`longdesc38-${version}.pane-open.txt`);
    const open = pending(`longdesc38-${version}.transcript`);
    assert.match(pane, /^ │ \S[^\n]*\n/);
    const q = permission(pane, open);
    assert.equal(q.toolUseId, 'toolu_main0');
    assert.equal(q.terminalWhy, 'cut');
    assert.equal(q.title, 'Permission request'); // whose it is, is not on screen
    assert.equal(permission(pane).terminalWhy, 'cut');
    // The rows above the box must be the END of the call's description.
    const other = { ...open[0], input: { ...open[0].input, description: `${open[0].input.description as string} and more` } };
    assert.equal(permission(pane, [other]).toolUseId, undefined);
  }
  // heredoc6 with its title row gone too (one row shorter): the description is the first row.
  const six = live('heredoc6-2.1.323.styled-tick0.txt');
  const rows = six.split('\n');
  const open = pending('heredoc6-2.1.323.transcript');
  assert.equal(permission(six, open).requiresTerminal, undefined);
  const noTitle = permission(rows.slice(1).join('\n'), open);
  assert.equal(noTitle.toolUseId, 'toolu_main0');
  assert.equal(noTitle.terminalWhy, 'cut');
  const noHeader = permission(rows.slice(2).join('\n'), open);
  assert.equal(noHeader.toolUseId, 'toolu_main0');
  assert.equal(noHeader.terminalWhy, 'cut');
  // Read by the pane alone the same holds: without the rule, only a first row
  // set as a Bash title says the dialog is on screen from its start. (Shown
  // from its start, it is still under a countdown with no call to tie it to:
  // that is what it takes no key for then — `unbound`, not `cut`.)
  assert.equal(permission(six).terminalWhy, 'unbound');
  assert.equal(permission(rows.slice(1).join('\n')).terminalWhy, 'cut'); // description first
  assert.equal(permission(rows.slice(2).join('\n')).terminalWhy, 'cut'); // top border first
  const sub = permission(live('subagent13-2.1.323.styled-open.txt')); // a subagent's title first
  assert.equal(sub.requiresTerminal, undefined);
  assert.equal(sub.title, 'Bash command · from the general-purpose agent');
});

// ── Round 6: one rule — no answer unless the pane positively shows what is being approved ──

test('a capture with attributes reads as the same text as a plain one', () => {
  const rows = (text: string) => text.replace(/\n+$/, '').split('\n');
  for (const version of ['2.1.323', '2.1.306']) {
    const styled = live(`titlelike-${version}.styled-description-first.txt`);
    assert.match(styled, /\x1b\[/);
    assert.deepEqual(rows(captureText(styled)), rows(live(`titlelike-${version}.pane-description-first.txt`)));
    assert.equal(/[\x00-\x09\x0b-\x1f]/.test(captureText(live(`heredoc6-${version}.styled-tick0.txt`))), false);
  }
  // Hyperlinks, charset shifts and sequences this reader has no use for are dropped whole.
  assert.equal(captureText('a\x1b]8;id=1;https://example.org/x\x1b\\b\x1b]8;;\x07c\x0e\x0fd\x1b[2Ke\x1b(Bf\x1b   '), 'abcdef');
  // …and a pane read through them is the same dialog.
  const plain = live('pair-2.1.323.pane-first.txt');
  assert.deepEqual(parseDialogPane(plain.replace(/^( Bash command)/m, ' \x1b[1m\x1b[38;5;153mBash command\x1b[0m').replace(/sleep 3/, '\x1b]8;;file:///x\x1b\\sleep 3\x1b]8;;\x1b\\')),
    parseDialogPane(plain));
});

for (const version of ['2.1.323', '2.1.306']) {
  test(`with the whole command box off screen a prompt takes no answer: it could be either of two requests (Claude ${version})`, () => {
    // The round-5 witness. 26 columns, two different calls in one turn:
    // "First sample / printf first", then "Second sample / printf second".
    // In 12 rows neither prompt shows its title, description or command — the
    // two screens are the same to the character.
    const [first, second] = ['first', 'second'].map((tag) => live(`boxless-${version}.styled-${tag}.txt`));
    assert.equal(captureText(first), captureText(second));
    assert.doesNotMatch(captureText(first), /[╌─]|printf|sample|Bash command/);
    for (const [pane, transcript] of [[first, 'first'], [second, 'second']] as const) {
      const open = pending(`boxless-${version}.transcript-${transcript}`);
      for (const q of [permission(pane, open), permission(pane), permission(captureText(pane), open)]) {
        assert.equal(q.terminalWhy, 'cut');
        assert.equal(q.requiresTerminal, true);
        // No pending call is offered as its identity: nothing on screen is any call's.
        assert.equal(q.toolUseId, undefined);
        assert.equal(q.lookalikes, undefined);
        assert.equal(q.title, 'Permission request');
        assert.deepEqual(q.options.map((o) => o.label), ['Yes', 'No']);
      }
    }
    assert.deepEqual(pending(`boxless-${version}.transcript-first`).map((u) => u.id), ['toolu_main0', 'toolu_main1']);
    assert.deepEqual(pending(`boxless-${version}.transcript-second`).map((u) => u.id), ['toolu_main1']);
    // The same two prompts with the pane tall enough are two requests, each answerable.
    const one = permission(live(`boxless-${version}.pane-full.txt`), pending(`boxless-${version}.transcript-first`));
    const two = permission(live(`boxless-${version}.pane-second-full.txt`), pending(`boxless-${version}.transcript-second`));
    assert.deepEqual([one.toolUseId, two.toolUseId], ['toolu_main0', 'toolu_main1']);
    assert.deepEqual([one.requiresTerminal, two.requiresTerminal], [undefined, undefined]);
    assert.notEqual(dialogSig(one), dialogSig(two));
  });

  test(`a countdown prompt with nothing of its request on screen is one notification through the ticks (Claude ${version})`, () => {
    // 80x10 under a countdown: the last reason row, the expiry notice, the question.
    const open = pending(`short10-${version}.transcript`);
    assert.equal(open.length, 1);
    const ticks = ['tick0', 'tick1'].map((tick) => live(`short10-${version}.styled-${tick}.txt`));
    assert.match(captureText(ticks[0]), /^ │ substitution output\n ⚠ Claude Code will automatically (block|deny) this request in 1:57,/);
    assert.notEqual(captureText(ticks[0]), captureText(ticks[1]));
    const qs = ticks.map((pane) => permission(pane, open));
    for (const q of qs) {
      assert.equal(q.terminalWhy, 'cut');
      assert.equal(q.toolUseId, undefined); // the one pending call is not inferred for a screen that shows none of it
      assert.match(q.detail!, /request in 1:5\d/); // posted as shown, clock included
    }
    assert.equal(dialogSig(qs[0]), dialogSig(qs[1]));
    // Only the notice's clock is set aside, and only where no answer is taken.
    const text = captureText(ticks[1]);
    assert.equal(dialogSig(permission(text, open)), dialogSig(qs[1]));
    for (const [shown, other] of [
      ['substitution output', 'substitution 1:56'],
      ['substitution output', 'substitution  output'],
      ['substitution output', 'substitution\n output'],
      ['2. No', '2. Never'],
      ['an unattended session', 'an attended session'],
      ['1:56,', '1:56'],
    ]) {
      assert.ok(text.includes(shown));
      assert.notEqual(dialogSig(permission(text.replace(shown, other), open)), dialogSig(qs[1]), other);
    }
    // A countdown-like suffix alone does not make a row an expiry notice.
    const suffixOnly = text.replace(/⚠ Claude Code will automatically (block|deny) this request in /, 'Job starts at ');
    assert.notEqual(dialogSig(permission(suffixOnly, open)), dialogSig(permission(suffixOnly.replace('1:56,', '1:55,'), open)));
    const full = permission(live(`short10-${version}.pane-full.txt`), open);
    assert.equal(full.requiresTerminal, undefined);
    assert.equal(full.toolUseId, 'toolu_main0');
  });

  test(`a first row that reads "Bash command" is a title only if it is set as one (Claude ${version})`, () => {
    // The round-5 witness: a background subagent's request whose DESCRIPTION is
    // "Bash command". In 13 rows the first row is its title, naming the
    // subagent; in 12 the title is off screen and the description is first.
    const full = live(`titlelike-${version}.pane-full.txt`);
    assert.match(full, /\n─+\n Bash command · from the general-purpose agent\n Bash command\n╌+\n rm -rf /);
    const titleFirst = live(`titlelike-${version}.styled-title-first.txt`);
    const descriptionFirst = live(`titlelike-${version}.styled-description-first.txt`);
    assert.match(captureText(titleFirst), /^ Bash command · from the general-purpose agent\n Bash command\n╌/);
    assert.match(captureText(descriptionFirst), /^ Bash command\n╌/);
    assert.deepEqual(pending(`titlelike-${version}.transcript`), []);
    // A pending call of the hand that the rows would fit changes nothing.
    const fitting = [bash('rm -rf "$(printf %s /tmp/scratch/sub)"', 'toolu_own', 'Bash command')];
    assert.match(captureText(descriptionFirst), /\n rm -rf "\$\(printf %s \/tmp\/scratch\/sub\)"\n/);

    for (const open of [[], fitting, [bash('rm -rf "$(printf %s /tmp/scratch/sub)"', 'toolu_own', null)]]) {
      const shown = permission(titleFirst, open);
      assert.equal(shown.requiresTerminal, undefined);
      assert.equal(shown.title, 'Bash command · from the general-purpose agent');
      assert.equal(shown.toolUseId, undefined);
      assert.match(shown.detail!, /^ Bash command\n╌/);

      for (const pane of [descriptionFirst, captureText(descriptionFirst)]) {
        const q = permission(pane, open);
        assert.equal(q.terminalWhy, 'cut');
        assert.equal(q.requiresTerminal, true);
        assert.equal(q.title, 'Permission request');
        assert.match(q.detail!, /^ Bash command\n╌/); // every row there is, under no title of its own
      }
    }
    // The hand's own title on the same screen: answerable only with its attributes.
    const own = live(`heredoc6-${version}.styled-tick0.txt`);
    const ownOpen = pending(`heredoc6-${version}.transcript`);
    assert.equal(permission(own, ownOpen).requiresTerminal, undefined);
    assert.equal(permission(own).terminalWhy, 'unbound'); // shown from its title; nothing ties it under its countdown
    assert.equal(permission(captureText(own), ownOpen).terminalWhy, 'cut');
    assert.equal(permission(captureText(own)).terminalWhy, 'cut');
    assert.equal(permission(live(`subagent13-${version}.pane-open.txt`)).terminalWhy, 'cut');
  });

  test(`an own request whose description says "· from …" is still the hand's own (Claude ${version})`, () => {
    // The round-5 regression: whose request it is, is read off the title row only.
    const open = pending(`descfrom-${version}.transcript`);
    assert.equal(open[0].input.description, 'Clean up the temporary directory · from the test run');
    const qs = ['tick0', 'tick1'].map((tick) => permission(live(`descfrom-${version}.pane-${tick}.txt`), open));
    for (const q of qs) {
      assert.equal(q.toolUseId, 'toolu_main0');
      assert.equal(q.requiresTerminal, undefined);
      assert.equal(q.title, 'Bash command');
      assert.match(q.detail!, /^ Clean up the temporary directory · from the test run\n╌/);
    }
    assert.equal(dialogSig(qs[0]), dialogSig(qs[1]));
    // The same words in the TITLE row are another requester's, whatever is pending.
    const pane = live(`descfrom-${version}.pane-tick0.txt`);
    const other = permission(pane.replace(/^ Bash command$/m, ' Bash command · from the general-purpose agent'), open);
    assert.equal(other.toolUseId, undefined);
    assert.equal(other.title, 'Bash command · from the general-purpose agent');
    // (Shown from its title. This capture has the hand's own countdown under it,
    // which a subagent's prompt does not have: untied under one, it takes no key.)
    assert.equal(other.terminalWhy, 'unbound');
    // …also with the rule off screen, where nothing proves which row the title is.
    const rows = pane.split('\n');
    const top = rows.findIndex((row) => /^─{6,}/.test(row));
    for (const [title, tied] of [[' Bash command', 'toolu_main0'], [' Bash command · from the general-purpose agent', undefined]] as const) {
      const q = permission([title, ...rows.slice(top + 2)].join('\n'), open);
      assert.equal(q.toolUseId, tied);
      assert.equal(q.terminalWhy, 'cut');
    }
  });
}

test('only bold on exactly the words "Bash command" makes a first row a title', () => {
  const plain = captureText(live('heredoc6-2.1.323.styled-tick0.txt'));
  const body = plain.slice(plain.indexOf('\n'));
  // Tied to its pending call, the prompt takes an answer exactly when its title is proven.
  const open = pending('heredoc6-2.1.323.transcript');
  const first = (row: string) => permission(row + body, open).requiresTerminal;
  assert.equal(first(' \x1b[1m\x1b[38;5;153mBash command\x1b[0m'), undefined); // as captured, dark theme
  assert.equal(first(' \x1b[1m\x1b[94mBash command\x1b[0m'), undefined); // dark-ansi
  assert.equal(first(' \x1b[0;1mBash command\x1b[22m'), undefined);
  assert.equal(first(' \x1b[1m\x1b[38;5;153mBash command\x1b[0m' + ' '.repeat(60) + '\x1b[38;5;246m1 of 2\x1b[39m'), undefined);
  for (const row of [
    ' Bash command',
    ' \x1b[38;5;246mBash command\x1b[39m', // a description: dim
    ' \x1b[2m\x1b[37mBash command\x1b[0m', // …in the ANSI theme: faint
    ' \x1b[38;5;1mBash command\x1b[39m', // colour 1 of 256 is not SGR 1
    ' \x1b[38;2;1;1;1mBash command\x1b[39m',
    ' \x1b[48;5;1m\x1b[4mBash command\x1b[0m',
    '\x1b[1m Bash command\x1b[0m', // the margin too
    ' \x1b[1mBash\x1b[0m command',
    ' \x1b[1mBash command and more\x1b[0m',
    ' \x1b[1mBash command\x1b[0m and more',
    ' \x1b[1m\x1b[22mBash command',
    ' \x1b[1m\x1b[mBash command',
    ' \uFFFD[1mBash command\uFFFD[0m', // an ESC in a description, as the TUI shows it
  ]) assert.equal(first(row), true, JSON.stringify(row));
  // Bold running on from an earlier row does not make the title row's margin plain.
  assert.equal(permission('\x1b[1m\n Bash command\x1b[0m' + body).requiresTerminal, true);
});

test('another tool\'s boxed prompt is answered from Zulip only with its opening rule on screen', () => {
  const pane = fixture('permission-untimed-create');
  const rows = pane.split('\n');
  const rule = rows.findIndex((row) => /^─{6,}/.test(row));
  assert.deepEqual(rows.slice(rule + 1, rule + 3), [' Create file', ' note.txt']);
  assert.equal(permission(pane).requiresTerminal, undefined);
  // One row shorter: the rule is gone, and with it any way to tell that
  // " Create file" is the dialog's first row and not, say, the end of a path.
  for (const cut of [1, 2, 3, 4]) {
    const q = permission(rows.slice(rule + cut).join('\n'));
    assert.equal(q.terminalWhy, 'cut', `${cut} row(s) off`);
    assert.equal(q.toolUseId, undefined);
    assert.deepEqual(q.options.map((o) => o.label).slice(0, 1), ['Yes']);
  }
});

test('question, options and footer are the pane\'s last rows, not look-alikes inside the command', () => {
  const open = pending('lookalike-2.1.323.transcript');
  assert.match(open[0].input.command as string, /echo "Do you want to proceed\?"\necho " 1\. Yes"/);
  const q = permission(live('lookalike-2.1.323.pane-tick0.txt'), open);
  assert.equal(q.toolUseId, 'toolu_main0');
  assert.equal(q.question, 'Do you want to proceed?');
  assert.deepEqual(q.options.map((o) => o.label), ['Yes', 'No']);

  // AskUserQuestion's markers in a command don't turn a permission prompt
  // into a question or a review screen (whose sweep would press 1 = Yes).
  const inBox = (rows: string) => BOXED.replace(/^ rm -rf [^\n]+$/m, () => rows);
  const marked = inBox(` echo '4. Chat about this' 'Ready to submit your answers?'`);
  assert.equal(permission(marked).question, 'Do you want to proceed?');
  const broken = marked.replace('   2. No', '   3. No'); // not a prompt we can read
  assert.equal(parseDialogPane(broken).kind, 'none');
  const heredoc = inBox(' │ cat <<EOF\n │ Ready to submit your answers?\n │   1. Apple\n │   4. Chat about this\n │ EOF');
  assert.match(heredoc, /╌\n │ cat <<EOF\n[\s\S]* │ EOF\n╌/);
  assert.equal(permission(heredoc).kind, 'permission');
  assert.equal(parseDialogPane(heredoc.replace('   2. No', '   3. No')).kind, 'none');
});

test('two pending calls: the prompt is tied to the one whose command it shows', () => {
  const both = pending('parallel-2.1.323.transcript-open');
  const first = permission(live('parallel-2.1.323.pane-open.txt'), both);
  const second = permission(live('parallel-2.1.323.pane-after1.txt'), pending('parallel-2.1.323.transcript-after1'));
  assert.equal(first.toolUseId, 'toolu_main0');
  assert.equal(second.toolUseId, 'toolu_main1');
  assert.notEqual(dialogSig(first), dialogSig(second));
  // Same pane read against a transcript that hasn't caught up: still the command on screen.
  assert.equal(permission(live('parallel-2.1.323.pane-after1.txt'), both).toolUseId, 'toolu_main1');
});

for (const version of ['2.1.323', '2.1.306']) {
  test(`a pending call is not necessarily the one asking: same command, told apart by what the dialog shows (Claude ${version})`, () => {
    // Two `sleep 3` calls in one turn. "first": 1 of 2 is asked. "overlap": it
    // was approved and is RUNNING — still without a result — while 2 of 2 is
    // asked. "second": it finished.
    const at = (tag: string) => permission(live(`pair-${version}.pane-${tag}.txt`), pending(`pair-${version}.transcript-${tag}`));
    assert.deepEqual(pending(`pair-${version}.transcript-overlap`).map((u) => [u.id, u.input.command, u.input.description]),
      [['toolu_main0', 'sleep 3', 'First sample'], ['toolu_main1', 'sleep 3', 'Second sample']]);
    const [first, overlap, second] = ['first', 'overlap', 'second'].map(at);
    assert.equal(first.toolUseId, 'toolu_main0');
    assert.match(first.shown!, /^ Bash command +1 of 2\n First sample\n╌+\n sleep 3\n╌+$/);
    assert.equal(overlap.toolUseId, 'toolu_main1'); // not the first pending one
    assert.match(overlap.shown!, /^ Bash command +2 of 2\n Second sample\n/);
    assert.notEqual(dialogSig(first), dialogSig(overlap));
    assert.equal(dialogSig(overlap), dialogSig(second));
    for (const q of [first, overlap, second]) assert.equal(q.requiresTerminal, undefined);
    // The order of the transcript decides nothing.
    const reversed = pending(`pair-${version}.transcript-overlap`).reverse();
    assert.equal(permission(live(`pair-${version}.pane-overlap.txt`), reversed).toolUseId, 'toolu_main1');
    assert.equal(permission(live(`pair-${version}.pane-first.txt`), reversed).toolUseId, 'toolu_main0');
  });

  test(`two pending calls that the dialog cannot tell apart are tied to neither and take no answer (Claude ${version})`, () => {
    // Same command AND same description; only the queue position moves. As on
    // PR #17 (TASK-BYSTH round 1 answered the one on screen).
    const at = (tag: string) => permission(live(`twin-${version}.pane-${tag}.txt`), pending(`twin-${version}.transcript-${tag}`));
    const [first, overlap, second] = ['first', 'overlap', 'second'].map(at);
    for (const q of [first, overlap]) {
      assert.equal(q.toolUseId, undefined);
      assert.deepEqual(q.lookalikes, ['toolu_main0', 'toolu_main1']);
      assert.equal(q.requiresTerminal, true);
      assert.equal(q.terminalWhy, 'lookalike');
    }
    // The queue position on screen stays in the identity: 1 of 2 is not 2 of 2.
    assert.notEqual(dialogSig(first), dialogSig(overlap));
    assert.notEqual(requestKey(first), requestKey(overlap));
    // Once the first call has its result, one call fits: a new post, tied.
    assert.equal(second.toolUseId, 'toolu_main1');
    assert.equal(second.requiresTerminal, undefined);
    assert.notEqual(dialogSig(overlap), dialogSig(second));
  });
}

test('a queue position on a narrow pane is still the hand\'s own title', () => {
  const q = permission(live('pair26-2.1.323.pane-first.txt'), pending('pair26-2.1.323.transcript-first'));
  assert.match(q.shown!, /^ Bash command {6}1 of 2\n First sample\n/);
  assert.equal(q.toolUseId, 'toolu_main0');
  assert.equal(q.requiresTerminal, undefined);
});

const HAND = { personaName: 'Scout', suffix: 'scout', tmuxSession: 'cc-scout' } as BotEntry;

test('the post is what the dialog shows; pending calls that both fit its rows leave it untied', () => {
  // A line break in the box may stand for a space or a newline in the command,
  // so two different pending calls can both match these rows. Then neither is
  // tied — whichever comes first in the transcript. What is posted is the rows
  // of the dialog on screen; the transcript adds nothing to them. Nothing
  // says which of the two is asking: it takes no key (as on PR #17).
  const shown = BOXED.replace(/^ rm -rf [^\n]+$/m, () => ' │ tail -f /dev/null #\n │ rm -rf "$HOME"');
  assert.match(shown, /╌\n │ tail -f/);
  const oneLine = bash('tail -f /dev/null # rm -rf "$HOME"', 'comment'); // the rm is a comment
  const twoLines = bash('tail -f /dev/null #\nrm -rf "$HOME"', 'runs-rm');
  for (const open of [[oneLine, twoLines], [twoLines, oneLine]]) {
    const q = permission(shown, open);
    assert.equal(q.toolUseId, undefined);
    assert.deepEqual(q.lookalikes, open.map((u) => u.id));
    assert.equal(q.terminalWhy, 'lookalike');
    assert.match(q.detail!, /\n │ tail -f \/dev\/null #\n │ rm -rf "\$HOME"\n╌/); // two rows, as on screen
    assert.match(q.shown!, /^ Bash command\n[\s\S]*\n │ tail -f \/dev\/null #\n │ rm -rf "\$HOME"\n╌+$/);
    const post = formatQuestionPosts(HAND, { sig: dialogSig(q), postedAt: '', questions: [q] }, 'CC Spawner').posts.join('\n');
    assert.match(post, /2 pending requests of this hand read exactly like this one, and nothing on its screen says which of them is asking\. An answer could reach another of them than the one you see, so I will not pass one on\./);
    assert.doesNotMatch(post, /comment|runs-rm|Answer with the displayed option number/);
    // The place in the queue is a row like any other — "2 of 2" is another
    // screen than "1 of 2" — but it does not say which call is asking: the
    // TUI's count starts over when no request is open, and the same place
    // comes round. No key with it either.
    const placed = (place: string) => permission(shown.replace(/^ Bash command$/m, ` Bash command${' '.repeat(60)}${place}`), open);
    for (const place of ['1 of 2', '2 of 2', '1 of 1', '3 of 2']) {
      assert.deepEqual(placed(place).lookalikes, open.map((u) => u.id), place);
      assert.equal(placed(place).terminalWhy, 'lookalike', place);
    }
    assert.notEqual(dialogSig(placed('1 of 2')), dialogSig(placed('2 of 2')));
    assert.notEqual(dialogSig(placed('1 of 2')), dialogSig(q));
  }
  const alone = permission(shown, [twoLines]);
  assert.equal(alone.toolUseId, 'runs-rm');
  assert.equal(alone.requiresTerminal, undefined);
  assert.notEqual(dialogSig(permission(shown, [oneLine, twoLines])), dialogSig(alone));
});

test('a subagent\'s prompt is never tied to the hand\'s own calls and still takes digits', () => {
  const pane = live('subagent-2.1.323.pane-open.txt');
  const q = permission(pane, pending('subagent-2.1.323.transcript'));
  assert.equal(q.title, 'Bash command · from the general-purpose agent');
  assert.equal(q.toolUseId, undefined);
  assert.equal(q.requiresTerminal, undefined); // footer: "Esc to cancel · Tab to amend · ctrl+x ctrl+k twice to stop background agents"
  assert.deepEqual(q.options.map((o) => o.label), ['Yes', 'No']);
  assert.match(q.detail!, /rm -rf "\$\(printf %s \/tmp\/scratch\/sub\)"/);
  // Even a pending call of the hand with the very same command and description is someone else's request.
  const same = [bash('rm -rf "$(printf %s /tmp/scratch/sub)"', 'toolu_1', 'sub rm')];
  assert.equal(permission(pane, same).toolUseId, undefined);
  assert.equal(dialogSig(permission(pane, same)), dialogSig(q));
  // Only the hand's own title — alone, or with its place in the queue — is tied; no other wording is guessed at.
  const titled = (title: string) => permission(pane.replace(' Bash command · from the general-purpose agent', title), same);
  assert.equal(titled(' Bash command').toolUseId, 'toolu_1');
  assert.equal(titled(' Bash command        2 of 3').toolUseId, 'toolu_1');
  for (const title of [' Bash command (unsandboxed)', ' Bash command ·', ' Bash command 2 of 3 · from the general-purpose agent', ' Bash']) {
    assert.equal(titled(title).toolUseId, undefined, title);
  }
});

for (const version of ['2.1.323', '2.1.306']) {
  test(`the requester named on screen wins over a look-alike pending call, rule on screen or not (Claude ${version})`, () => {
    // 80x13: the rule has scrolled off and the pane's FIRST row is the
    // subagent's title. The hand's transcript has nothing pending.
    const pane = live(`subagent13-${version}.styled-open.txt`);
    assert.match(captureText(pane), /^ Bash command · from the general-purpose agent\n sub rm\n╌/);
    assert.deepEqual(pending(`subagent13-${version}.transcript`), []);
    const real = permission(pane, pending(`subagent13-${version}.transcript`));
    // A pending call of the hand with the same command and description changes nothing.
    const same = [bash('rm -rf "$(printf %s /tmp/scratch/sub)"', 'toolu_own', 'sub rm')];
    for (const open of [same, [...same, bash('true', 'toolu_other')], [bash('rm -rf "$(printf %s /tmp/scratch/sub)"', 'toolu_own', 'Bash command · from the general-purpose agent sub rm')]]) {
      const q = permission(pane, open);
      assert.equal(q.toolUseId, undefined);
      assert.equal(q.lookalikes, undefined);
      assert.equal(dialogSig(q), dialogSig(real)); // identified by its rows, title row included
      assert.equal(q.title, 'Bash command · from the general-purpose agent');
      assert.match(q.detail!, /^ sub rm\n/);
      assert.equal(q.requiresTerminal, undefined);
    }
    // The same rows under the hand's own title are the hand's.
    const ownTitle = pane.replace(/ \x1b\[[0-9;]*m· \x1b\[[0-9;]*mfrom the general-purpose agent/, '');
    assert.match(captureText(ownTitle), /^ Bash command\n sub rm\n/);
    assert.equal(permission(ownTitle, same).toolUseId, 'toolu_own');
    // Without attributes nothing proves the first row is a title: no answer, and no tie to the look-alike.
    const unproven = permission(captureText(pane), same);
    assert.equal(unproven.toolUseId, undefined);
    assert.equal(unproven.terminalWhy, 'cut');
  });

  test(`the hand's own request at the head of a queue of subagents' is tied by its own title (Claude ${version})`, () => {
    // Live: the hand's Bash call and three background subagents' calls with the
    // same command and description, all waiting. "1 of 4" is the hand's own.
    const pane = live(`queue4-${version}.pane-open.txt`);
    const open = pending(`queue4-${version}.transcript`);
    assert.deepEqual(open.map((u) => u.name), ['Bash']); // the Agent call returned at once
    assert.match(pane, /\n Esc to cancel · Tab to amend\n$/); // no hint of the background agents in the footer
    const q = permission(pane, open);
    assert.equal(q.toolUseId, 'toolu_main1');
    assert.match(q.shown!, /^ Bash command +1 of 4\n sub rm\n/);
    // The next in the queue shows the same rows under another title: not tied.
    const next = pane.replace(/ Bash command( +)1 of 4/, (_m, pad: string) => ` Bash command · from the general-purpose agent${pad.slice(' · from the general-purpose agent'.length)}2 of 4`);
    assert.match(next, / agent +2 of 4\n sub rm\n/);
    assert.equal(permission(next, open).toolUseId, undefined);
    assert.notEqual(dialogSig(permission(next, open)), dialogSig(q));
  });
}

test('on a narrow pane a subagent\'s title is set in two columns and is still not the hand\'s', () => {
  const pane = live('subagent38-2.1.323.pane-open.txt');
  assert.match(pane, /\n Bash +· from the\n command +general-purpose agent\n sub rm\n╌/);
  const command = 'rm -rf "$(printf %s /tmp/' + pane.match(/task-40kjf-\w+/)![0] + '/sub)"';
  const q = permission(pane, [bash(command, 'toolu_own', 'sub rm')]);
  assert.match(q.detail!.replace(/\s+/g, ''), new RegExp(command.replace(/\s+/g, '').replace(/[$()"]/g, '\\$&')));
  assert.equal(q.toolUseId, undefined);
  // Its footer is cut short at this width ("… · ctrl…"), still naming the digit list.
  assert.equal(q.requiresTerminal, undefined);
});

test('the same tool_use with other options or another input mode is another signature', () => {
  const open = [bash(BOXED_COMMAND)];
  const q = permission(BOXED, open);
  assert.equal(q.toolUseId, 'toolu_1');
  assert.equal(dialogSig(q), dialogSig(permission(BOXED.replace('in 1:59', 'in 0:03'), open)));
  assert.notEqual(dialogSig(q), dialogSig(permission(BOXED.replace('2. No', '2. No, never'), open)));
  assert.notEqual(dialogSig(q), dialogSig(permission(BOXED.replace(' ❯ 1. Yes', '   1. Yes'), open)));
  assert.notEqual(dialogSig(q), dialogSig(permission(BOXED, [bash(BOXED_COMMAND, 'toolu_2')])));
  // The rows the box displays are part of it: same call, shown differently, is posted anew.
  const respaced = permission(BOXED.replace(/^ rm -rf "/m, ' rm  -rf "'), open);
  assert.equal(respaced.toolUseId, 'toolu_1');
  assert.notEqual(dialogSig(q), dialogSig(respaced));
  assert.notEqual(dialogSig(q), dialogSig(permission(BOXED)));
});

// ── Footers and input modes ──

test('footers wrapped onto the last row still belong to their own dialog', () => {
  // 26 columns: "Esc to cancel · Tab to" / "amend".
  const narrow = permission(live('untimed-wrapped26-2.1.323.pane.txt'));
  assert.equal(narrow.title, 'Bash command');
  assert.deepEqual(narrow.options.map((o) => o.label), ['Yes', 'No']);
  assert.equal(narrow.requiresTerminal, undefined);
  assert.match(narrow.detail!, /printf reviewer/);
  assert.equal(permission(live('narrow26-2.1.323.pane-tick0.txt'), pending('narrow26-2.1.323.transcript')).requiresTerminal, undefined);

  // 38 columns: AskUserQuestion's "… to navigate ·" / "Esc to cancel".
  const ask = parseDialogPane(live('ask-wrapped38-2.1.323.pane.txt'));
  assert.equal(ask.kind, 'question');
  if (ask.kind !== 'question') return;
  assert.equal(ask.q.kind, undefined);
  assert.equal(ask.q.question, 'Which fruit should I use?');
  assert.deepEqual(ask.q.options.map((o) => o.label), ['Apple', 'Banana']);
  assert.equal(ask.q.textOptionIndex, 3);
  // An AskUserQuestion that happens to ask "Do you want to …?" is still one, with or without its rule and footer.
  for (const pane of [
    live('ask-wrapped38-2.1.323.pane.txt').replace('Which fruit should I use?', 'Do you want to use a fruit?'),
    ASK.replace('Which fruit should I use?', 'Do you want to use a fruit?'),
    `${ASK.replace('Which fruit should I use?', 'Do you want to use a fruit?')}\n\nEnter to select · ↑/↓ to navigate · Esc to cancel`,
  ]) {
    const d = parseDialogPane(pane);
    assert.equal(d.kind, 'question');
    if (d.kind !== 'question') continue;
    assert.equal(d.q.kind, undefined);
    assert.equal(d.q.question, 'Do you want to use a fruit?');
    assert.deepEqual(d.q.options.map((o) => o.label), ['Apple', 'Banana']);
  }
  // Entries under the marker (as in plan-mode interviews) don't hide the dialog.
  const more = parseDialogPane(`${ASK}\n  5. Skip interview and plan immediately\n\nEnter to select · ↑/↓ to navigate · Esc to cancel`);
  assert.equal(more.kind, 'question');
  if (more.kind === 'question') assert.deepEqual(more.q.options.map((o) => o.label), ['Apple', 'Banana']);
});

test('only the cursor list takes a bare digit: the screen-reader layout is read as such, unknown input layouts take no key', () => {
  for (const name of ['ax-2.1.323', 'ax-2.1.306']) {
    const open = pending(`${name}.transcript`);
    const q = permission(live(`${name}.pane-tick0.txt`), open);
    // TASK-BYSTH: answered in steps (digit, look, Enter) — no longer terminal-only.
    assert.equal(q.requiresTerminal, undefined);
    assert.equal(q.entry, 'reader');
    assert.equal(q.typed, undefined);
    assert.equal(q.cursor, undefined);
    assert.equal(q.toolUseId, 'toolu_main0'); // one post for the life of the prompt
    assert.equal(q.expiry?.clock, 'about 2 minutes');
    assert.equal(q.expiry?.seconds, undefined); // not a clock to hold an answer to
    assert.match(q.shown!, /^Permission Required: Bash command\n> Local scratch-only permission prompt probe\n[\s\S]*\n> rm -rf [\s\S]*\n> Dangerous rm operation/);
    assert.match(q.detail!, /automatically (block|deny) this request in about 2 minutes/);
    assert.equal(permission(live(`${name}.pane-tick0.txt`), [bash(`${open[0].input.command as string} && true`)]).toolUseId, undefined);
  }
  // Heading scrolled off: not shown from its start, no key. Instruction
  // wrapped over two rows; a typed digit awaiting Enter.
  for (const [name, entry, typed, why] of [
    ['permission-ax-clipped', 'reader', undefined, 'cut'], ['permission-ax-open', 'reader', undefined, undefined], ['permission-ax-typed', 'reader', '2', undefined],
  ] as const) {
    const q = permission(fixture(name), [bash(BOXED_COMMAND)]);
    assert.equal(q.entry, entry, name);
    assert.equal(q.typed, typed, name);
    assert.equal(q.terminalWhy, why, name);
    assert.equal(q.requiresTerminal, why ? true : undefined, name);
    assert.deepEqual(q.options.map((o) => o.label), ['Yes', 'No']);
  }
  assert.equal(permission(fixture('permission-ax-clipped'), [bash(BOXED_COMMAND)]).toolUseId, undefined);
  // The typed digit is part of what a post says, not of which request it is.
  const [empty, digit] = ['permission-ax-open', 'permission-ax-typed'].map((name) => permission(fixture(name), [bash(BOXED_COMMAND)]));
  assert.notEqual(dialogSig(empty), dialogSig(digit));
  assert.equal(requestKey(empty), requestKey(digit));
  // The layout is known by its instruction line: another range than the
  // options listed, more typed than a few characters, or rows between its
  // quoted block and the question that are not its expiry notice, and it is not.
  const reader = fixture('permission-ax-open');
  assert.equal(permission(reader.replace('[1-2]', '[1-3]')).terminalWhy, 'input');
  assert.equal(permission(fixture('permission-ax-typed').replace('cancel: 2', 'cancel: 21212')).terminalWhy, 'input');
  // A field with blanks in it cannot be counted from here (a leading one
  // would stay behind the backspaces): not an input known to be read.
  for (const field of ['cancel:  2', 'cancel: 1 2', 'cancel:   ']) {
    const blank = permission(fixture('permission-ax-typed').replace('cancel: 2', field), [bash(BOXED_COMMAND)]);
    assert.equal(blank.entry, field.trim() === 'cancel:' ? 'reader' : undefined, JSON.stringify(field));
    assert.equal(blank.terminalWhy, field.trim() === 'cancel:' ? undefined : 'input', JSON.stringify(field));
  }
  // (That last one is `layout`, not `cut`: the prompt is on screen from its
  // heading, and a taller terminal would show nothing more of it.)
  assert.equal(permission(reader.replace('\nDo you want to proceed?', '\nsome other row\nDo you want to proceed?')).terminalWhy, 'layout');
  assert.equal(permission(reader.replace('Permission Required: Bash command', 'Permission Required: Bash command\n> x\nPermission Required: Bash command')).terminalWhy, 'cut');
  assert.equal(permission(PERMISSION.replace(' ❯ 1. Yes', '   1. Yes')).requiresTerminal, true);
  assert.equal(permission(PERMISSION.replace('\n Esc to cancel', '\n Press Enter to confirm\n Esc to cancel')).requiresTerminal, true);
});

// Review of e90e6be (LOW): two screen-reader prompts that were all on screen,
// with their call pending, and posted as "top off the hand's screen".
test("screen-reader layout: the TUI's own hint row is known; any other row there is an unknown layout, not a short terminal", () => {
  for (const version of ['2.1.323', '2.1.306']) {
    const pane = live(`reader-rule-${version}.pane-open.txt`);
    assert.match(pane, /\n> Permission rule Bash requires confirmation for this command\.\n\/permissions to update rules\nDo you want to proceed\?\n/);
    const call = bash('printf reviewer', 'toolu_main0', 'Print a word');
    const q = permission(pane, [call]);
    assert.equal(q.title, 'Bash command');
    assert.equal(q.toolUseId, 'toolu_main0');
    assert.equal(q.entry, 'reader');
    assert.equal(q.requiresTerminal, undefined, version);
    // The post shows the hint row with the rest: nothing on screen is left out of it.
    const post = formatQuestionPosts(HAND, { sig: dialogSig(q), postedAt: '', questions: [q] }, 'CC Spawner').posts.join('\n');
    assert.match(post, /\n> Permission rule Bash requires confirmation for this command\.\n\/permissions to update rules\n```\n/);
    assert.match(post, /answer hand:cc-scout <number>/);
    // With no call to tie it to it takes no key, as any screen-reader prompt.
    assert.equal(permission(pane).terminalWhy, 'unbound');
    // A row there that is not known: posted as that — nothing about its height.
    for (const strange of [pane.replace('/permissions to update rules', '/permissions to update rules\nPress ? for more'), pane.replace('/permissions to update rules', '/permissions  to update rules now')]) {
      const odd = permission(strange, [call]);
      assert.equal(odd.terminalWhy, 'layout');
      assert.equal(odd.toolUseId, 'toolu_main0'); // a readable transcript does not make it answerable
      const card = formatQuestionPosts(HAND, { sig: dialogSig(odd), postedAt: '', questions: [odd] }, 'CC Spawner').posts.join('\n');
      assert.match(card, /Between this request and its question the screen shows rows I do not know from this layout.*will not pass on an answer to it\. What follows is what its screen shows\. This permission prompt requires terminal input\./);
      assert.doesNotMatch(card, /off the hand.s screen|too short|answer hand:cc-scout <number>/);
      assert.match(card, /\n\*\*Bash command\*\*\n```\n> Print a word\n> printf reviewer\n/);
    }
  }
});

test('screen-reader layout: the hand\'s own heading with its place in the queue is tied to its call; a subagent\'s is not', () => {
  for (const version of ['2.1.323', '2.1.306']) {
    const command = 'sleep 20 && rm -rf "$(printf %s /tmp/scratch/sub)"';
    // The hand's transcript: its Agent call and its own Bash call. The
    // subagent's call, the same command and description, is in another file.
    const open: OpenToolUse[] = [{ id: 'toolu_main0', name: 'Agent', input: { description: 'probe' } }, bash(command, 'toolu_main1', 'sub rm')];
    const own = permission(live(`reader-queue-${version}.pane-own.txt`), open);
    assert.equal(own.title, 'Bash command 1 of 4');
    assert.equal(own.toolUseId, 'toolu_main1');
    assert.equal(own.entry, 'reader');
    assert.equal(own.requiresTerminal, undefined, version);
    assert.match(own.shown!, /^Permission Required: Bash command 1 of 4\n> sub rm\n> sleep 20/);
    // Another command pending, or none: not tied, and under its countdown no key.
    assert.equal(permission(live(`reader-queue-${version}.pane-own.txt`), [bash(`${command} && true`, 'toolu_main1', 'sub rm')]).terminalWhy, 'unbound');
    assert.equal(permission(live(`reader-queue-${version}.pane-own.txt`)).terminalWhy, 'unbound');
    // The subagent's prompt reads the same below its heading, and the hand's
    // call is still pending: tied to nothing, no key — and not the same request.
    const sub = permission(live(`reader-queue-${version}.pane-subagent.txt`), open);
    assert.equal(sub.title, 'Bash command · from the general-purpose agent 2 of 4');
    assert.equal(sub.toolUseId, undefined);
    assert.equal(sub.terminalWhy, 'unbound');
    assert.notEqual(requestKey(sub), requestKey(own));
    assert.equal(sameDialog({ sig: dialogSig(own), questions: [own] }, sub), false);
    // The place in the queue is part of what is on screen, never what ties it.
    const second = permission(live(`reader-queue-${version}.pane-own.txt`).replace('Bash command 1 of 4', 'Bash command 3 of 4'), open);
    assert.equal(second.toolUseId, 'toolu_main1');
    assert.notEqual(dialogSig(second), dialogSig(own));
    for (const title of ['Bash command 1 of', 'Bash command  1 of 4', 'Bash command 1 of 4 more', 'Bash commands 1 of 4']) {
      assert.equal(permission(live(`reader-queue-${version}.pane-own.txt`).replace('Bash command 1 of 4', title), open).toolUseId, undefined, title);
    }
  }
});

test('amending is not the digit list: a cursor alone does not make a digit an answer; the amended row is read as that', () => {
  for (const version of ['2.1.323', '2.1.306']) {
    const open = pending(`amend-${version}.transcript`);
    // As asked: cursor list, footer "Esc to cancel · Tab to amend".
    const list = permission(live(`amend-${version}.pane-open.txt`), open);
    assert.equal(list.requiresTerminal, undefined);
    assert.equal(list.toolUseId, 'toolu_main0');
    // After Tab (on Yes, and on No): same request, same cursor, but the row
    // is a text field and a digit would be typed into it. Footer: "Esc to cancel".
    for (const [tag, labels] of [['yes', ['Yes, and tell Claude what to do next', 'No']], ['no', ['Yes', 'No, and tell Claude what to do differently']]] as const) {
      const pane = live(`amend-${version}.pane-${tag}.txt`);
      assert.match(pane, /\n Esc to cancel\n$/);
      assert.equal(pane.match(/❯ \d\. /g)?.length, 1);
      for (const q of [permission(pane, open), permission(pane)]) {
        assert.deepEqual(q.options.map((o) => o.label), labels);
        // TASK-BYSTH: read as what it is — the list after Tab — and answered
        // by leaving the field first, where a pending call says which request
        // it is (two keys, a look between them). A digit alone is never sent
        // to it; with nothing but its rows to go by it takes no key at all.
        assert.equal(q.terminalWhy, q.toolUseId ? undefined : 'unbound');
        assert.equal(q.entry, 'amend');
        assert.equal(q.cursor, tag === 'yes' ? 1 : 2);
      }
      assert.equal(permission(pane, open).toolUseId, 'toolu_main0');
      assert.notEqual(dialogSig(permission(pane, open)), dialogSig(list));
      // The same request as the list's, in another state.
      assert.equal(requestKey(permission(pane, open)), requestKey(list));
      assert.equal(requestKey(permission(pane)), requestKey(permission(live(`amend-${version}.pane-open.txt`))));
    }
    assert.equal(list.entry, 'list');
    assert.equal(list.cursor, 1);
    // The reported heredoc prompt, amended while its countdown ran.
    const heredoc = permission(live(`amend-heredoc6-${version}.pane-yes.txt`), pending(`amend-heredoc6-${version}.transcript`));
    assert.equal(heredoc.toolUseId, 'toolu_main0');
    assert.equal(heredoc.entry, 'amend');
    assert.equal(heredoc.expiry, undefined); // the countdown is gone while amending
    // 26 columns: a blank row follows the text field. Both options are still
    // read (the post lists them), and it is still not the cursor list.
    const narrow = live(`amend26-${version}.pane-yes.txt`);
    assert.match(narrow, /\n ❯ 1\. Yes,and tell Claude…\n\n   2\. No\n\n Esc to cancel\n$/);
    const spaced = permission(narrow, pending(`amend26-${version}.transcript`));
    assert.deepEqual(spaced.options.map((o) => o.label), ['Yes,and tell Claude…', 'No']);
    assert.equal(spaced.entry, 'amend');
    assert.equal(spaced.requiresTerminal, undefined);
    assert.equal(spaced.toolUseId, 'toolu_main0');
  }
  // Options set apart by blank rows are not the cursor list, whatever the footer says.
  const apart = permission(PERMISSION.replace(' ❯ 1. Yes\n', ' ❯ 1. Yes\n\n'));
  assert.deepEqual(apart.options.map((o) => o.label), ['Yes', 'No']);
  assert.equal(apart.terminalWhy, 'input');
  // …and a blank row is not skipped to reach a row that is not the next option:
  // that row is unknown text under the options, which is terminal-only too.
  const gap = permission(PERMISSION.replace('   2. No\n', '\n   3. No\n'));
  assert.deepEqual(gap.options.map((o) => o.label), ['Yes']);
  assert.equal(gap.terminalWhy, 'input');
  // A typed digit shows up in the amendment, not as a choice: still the amend field.
  const typedInto = permission(PERMISSION.replace('1. Yes', '1. Yes, 2').replace(' · Tab to amend', ''));
  assert.equal(typedInto.entry, 'amend');
  assert.equal(requestKey(typedInto), requestKey(permission(PERMISSION)));
  // A cursor list without the hint and without an amended row is no state known here.
  assert.equal(permission(PERMISSION.replace('Esc to cancel · Tab to amend', 'Esc to cancel')).requiresTerminal, true);
  assert.equal(permission(PERMISSION.replace('Esc to cancel · Tab to amend', 'Esc to cancel')).terminalWhy, 'input');
  // Only the row the cursor is on reads by its first word; another row that
  // starts the same is that option, whole.
  const three = PERMISSION.replace('   2. No', "   2. Yes, and don't ask again\n   3. No");
  assert.notEqual(requestKey(permission(three)), requestKey(permission(three.replace("2. Yes, and don't ask again", '2. Yes'))));
  // …and with the cursor on it under a footer without the hint, it is still
  // that option — a row between the first and the last is no text field.
  const onSecond = permission(three.replace(' ❯ 1. Yes', '   1. Yes').replace("   2. Yes, and don't ask again", " ❯ 2. Yes, and don't ask again").replace(' · Tab to amend', ''));
  assert.equal(onSecond.entry, undefined);
  assert.equal(onSecond.terminalWhy, 'input');
  // The last row amended ("No, …") is one; the first as "No, …" or the last as "Yes, …" is not.
  const footless = three.replace(' · Tab to amend', '').replace(' ❯ 1. Yes', '   1. Yes');
  assert.equal(permission(footless.replace('   3. No', ' ❯ 3. No, and tell Claude what to do differently')).entry, 'amend');
  assert.equal(permission(footless.replace('   3. No', ' ❯ 3. Yes, x')).entry, undefined);
  assert.equal(permission(PERMISSION.replace(' ❯ 1. Yes', ' ❯ 1. No, x').replace(' · Tab to amend', '')).entry, undefined);
  // The list's footer wrapped, or followed by more hints, is still the list's.
  assert.equal(permission(PERMISSION.replace('Esc to cancel · Tab to amend', 'Esc to cancel · Tab to\n amend')).requiresTerminal, undefined);
  assert.equal(permission(PERMISSION.replace('Tab to amend', 'Tab to amend · ctrl+x ctrl+k twice to stop background agents')).requiresTerminal, undefined);
  assert.equal(permission(PERMISSION.replace('Tab to amend', 'Tab to …')).requiresTerminal, true);
});

// ── Untied prompts: every row above the question is the identity ──

test('the permission question comes from the option block, not an interrogative description', () => {
  const pane = BOXED.replace(' Local scratch-only permission prompt probe\n╌', ' Do you want to continue?\n╌');
  const q = permission(pane);
  assert.equal(q.question, 'Do you want to proceed?');
  assert.match(q.detail!, /Do you want to continue\?\n╌+\n rm -rf/);
  assert.notEqual(dialogSig(q), dialogSig(permission(pane.replaceAll('/nonexistent', '/another-target'))));
});

test('an AX-looking body row does not hide preceding detail without AX submit instructions', () => {
  const pane = ['──────────', 'Permission request', 'Display A', 'Permission Required: status',
    'plain detail', 'Do you want to proceed?', '1. Yes', '2. No', 'Esc to cancel'].join('\n');
  const q = permission(pane);
  assert.notEqual(q.title, 'status');
  assert.match(q.detail!, /Display A\nPermission Required: status\nplain detail/);
  assert.notEqual(dialogSig(q), dialogSig(permission(pane.replace('Display A', 'Display B'))));

  const ordinary = permission(PERMISSION.replace(' Dangerous rm', 'Permission Required: status\n Dangerous rm'));
  assert.equal(ordinary.title, 'Bash command');
  assert.equal(ordinary.requiresTerminal, undefined);
  assert.match(ordinary.detail!, /rm -rf[\s\S]*Permission Required: status/);
});

test('a malformed option block is not bridged', () => {
  assert.equal(parseDialogPane(PERMISSION.replace('2. No', '3. No')).kind, 'none');
  assert.equal(parseDialogPane(PERMISSION.replace(' ❯ 1.', ' Unknown input mode\n ❯ 1.')).kind, 'none');
  assert.equal(parseDialogPane(PERMISSION.replace(' Esc to cancel · Tab to amend', ' ? for shortcuts')).kind, 'none');
  // Hints after the footer's first words, on its row or wrapped under it, are still the footer.
  assert.equal(permission(PERMISSION + '\n ctrl+e to explain').requiresTerminal, undefined);
  assert.equal(permission(PERMISSION.replace(' · Tab to amend', ', Tab to amend')).requiresTerminal, undefined);
});

test('without a pending tool_use every row is the identity; under the TUI\'s expiry notice such a prompt takes no key and is one post through its ticks', () => {
  // PR #17: the notice counted like any row — the prompt was another one every
  // second, reposted per tick, an answer after a tick refused. TASK-BYSTH
  // round 1 set the notice aside and held an answer to the time it ends; a
  // request asked right after another ends a moment after it, so that proved
  // nothing. Now the notice — the rows that END the detail, under the command
  // box — makes an untied prompt one that takes no answer, posted once.
  // Countdown text anywhere else is the request's own and counts as ever.
  const LOOKALIKE = '⚠ Claude Code will automatically block this request in 0:24, to avoid holding up an unattended session';
  for (const pane of [
    BOXED,
    BOXED.replace(' Bash command\n', ` Bash command\n ${LOOKALIKE}\n`),
    BOXED.replace(' │ Dangerous rm', ` │ ${LOOKALIKE}\n │ Dangerous rm`),
    BOXED.replace(/^╌+\n/m, ''),
    PERMISSION.replace(' Dangerous rm', ` ${LOOKALIKE}\n Dangerous rm`),
    // …in the command box, as its last rows:
    BOXED.replace(/^( rm -rf [^\n]+)$/m, `$1\n ${LOOKALIKE}`),
  ]) {
    const q = permission(pane);
    assert.equal(q.toolUseId, undefined);
    // (BOXED without its top border, under its rule, is no layout known here:
    // no command box to look under. Its rows end in the notice all the same —
    // round 2 looks for it from the title down in such a dialog: PR #17 had
    // its clock count as a row, and an answer at the same tick was passed on.)
    const timed = pane.includes('1:59');
    assert.equal(q.terminalWhy, timed ? 'unbound' : undefined);
    for (const [from, to] of [['0:24', '0:25'], ['nonexistent', 'nonexistenu'], ['Dangerous rm', 'Dangerous mv']]) {
      if (pane.includes(from)) assert.notEqual(dialogSig(q), dialogSig(permission(pane.replaceAll(from, to))), `${from} → ${to}`);
    }
    if (timed) {
      assert.equal(q.expiry?.seconds, 119);
      assert.equal(dialogSig(q), dialogSig(permission(pane.replace('1:59', '1:58'))), 'the notice under the request: one post through its ticks');
      // The same rows without a notice are another prompt — one that takes an answer, by its rows.
      const [from, to] = q.expiry!.rows;
      const rows = pane.split('\n');
      const at = rows.findIndex((row) => row.includes('will automatically block this request in 1:59'));
      const bare = permission([...rows.slice(0, at), ...rows.slice(at + to - from)].join('\n'));
      assert.equal(bare.requiresTerminal, undefined);
      assert.equal(bare.expiry, undefined);
      assert.notEqual(dialogSig(q), dialogSig(bare));
      assert.notEqual(requestKey(q), requestKey(bare));
    } else {
      assert.equal(q.expiry, undefined);
    }
  }
  // A notice with rows after it is not the one that ends the detail.
  const trailed = permission(BOXED.replace(' Do you want to proceed?', ' some other row\n\n Do you want to proceed?'));
  assert.equal(trailed.expiry, undefined);
  assert.notEqual(dialogSig(trailed), dialogSig(permission(BOXED.replace(' Do you want to proceed?', ' some other row\n\n Do you want to proceed?').replace('1:59', '1:58'))));
});

test('an expiry notice never says "the same request"; it says "another" — it ends at another time, reads more minutes, or is there after a key', () => {
  const notice = (q: PendingQ, readAt: number) => stampExpiry({ kind: 'question' as const, q: structuredClone(q) }, readAt).q.expiry;
  const t0 = 1_800_000_000_000;
  const exact = permission(BOXED); // "1:59"
  const at = (clock: string, ms: number) => notice(permission(BOXED.replace('1:59', clock)), t0 + ms);
  assert.equal(at('1:59', 0)?.at, t0 + 119_000);
  // One countdown, read again: allowed (and no more than that — see sameDialog).
  for (const [clock, ms] of [['1:39', 20_000], ['1:40', 20_000], ['1:38', 20_000], ['1:57', 0]] as const) assert.equal(expiryAllows(at('1:59', 0), at(clock, ms)), true, clock);
  // Asked again: the clock is back at 1:59, or reads what a countdown started 10 s / 4 s later would.
  assert.equal(expiryAllows(at('1:59', 0), at('1:59', 20_000)), false);
  assert.equal(expiryAllows(at('1:59', 0), at('1:49', 20_000)), false);
  assert.equal(expiryAllows(at('1:59', 0), at('1:55', 0)), false);
  // The notice gone (a key at the dialog dropped it): nothing to refuse on.
  assert.equal(expiryAllows(at('1:59', 0), undefined), true);
  // A notice where there was none is a request asked since: a key takes the
  // notice away for good, and a prompt read without one does not grow one.
  assert.equal(expiryAllows(undefined, at('1:59', 0)), false);
  assert.equal(expiryAllows(undefined, undefined), true);
  assert.ok(exact.expiry && exact.expiry.at === undefined && exact.expiry.about === undefined);
  // The screen-reader layout counts in minutes: no end time. It only goes down.
  for (const version of ['2.1.323', '2.1.306']) {
    const pane = live(`reader-${version}.pane-open.txt`);
    const two = notice(permission(pane), t0);
    const one = notice(permission(pane.replace('about 2 minutes', 'about 1 minute')), t0 + 70_000);
    assert.deepEqual([two?.clock, two?.about, two?.at, one?.about], ['about 2 minutes', 120, undefined, 60]);
    assert.equal(expiryAllows(two, one), true);
    assert.equal(expiryAllows(two, notice(permission(pane), t0 + 8_000)), true); // 8 s on, the next request reads the same: no proof either way
    assert.equal(expiryAllows(one, two), false); // more than it read: asked again
    assert.equal(expiryAllows(two, at('0:45', 75_000)), true); // on to seconds
    assert.equal(expiryAllows(at('0:45', 75_000), two), false);
  }
});

test('in steps, the request is the pending call that identifies it — with or without its expiry notice, which the TUI drops at the first key', () => {
  for (const version of ['2.1.323', '2.1.306']) {
    // heredoc6 under its countdown, and after Tab (amend-heredoc6): no notice, one blank row fewer.
    // Not the same capture session (other scratch paths were replaced alike), same rows, same call.
    const names = [`heredoc6-${version}.styled-tick0.txt`, `amend-heredoc6-${version}.pane-yes.txt`];
    const [ticking, amended] = names.map((name, i) => permission(live(name), pending(`${i ? 'amend-' : ''}heredoc6-${version}.transcript`)));
    assert.deepEqual([ticking.title, amended.title], ['Bash command', 'Bash command']); // both shown from their title
    assert.deepEqual([ticking.toolUseId, amended.toolUseId], ['toolu_main0', 'toolu_main0']);
    assert.deepEqual([ticking.requiresTerminal, amended.requiresTerminal], [undefined, undefined]);
    assert.ok(ticking.expiry);
    assert.equal(amended.expiry, undefined);
    assert.notEqual(dialogSig(ticking), dialogSig(amended));
    assert.equal(requestKey(ticking), requestKey(amended));
    assert.notEqual(requestKey(ticking), requestKey(permission(live(names[1]).replace('scratch line 3', 'scratch line X'), pending(`amend-heredoc6-${version}.transcript`))));
    // By their rows alone nothing says the prompt without the notice is the
    // one that had it (TASK-BYSTH round 1 took it for that, and after a Tab
    // sent the digit to a request asked meanwhile — review control "between").
    // Neither takes a key: one is under a countdown, the other in its text field.
    const [bare, bareAmended] = names.map((name) => permission(live(name)));
    assert.deepEqual([bare.terminalWhy, bareAmended.terminalWhy], ['unbound', 'unbound']);
    assert.notEqual(requestKey(bare), requestKey(bareAmended));
    // The screen-reader layout: typed into, its notice is gone too.
    const reader = pending(`reader-${version}.transcript`);
    const [open, typed] = ['open', 'typed'].map((tag) => permission(live(`reader-${version}.pane-${tag}.txt`), reader));
    assert.ok(open.expiry);
    assert.equal(typed.expiry, undefined);
    assert.deepEqual([open.toolUseId, open.requiresTerminal, open.entry], ['toolu_main0', undefined, 'reader']);
    assert.equal(requestKey(open), requestKey(typed));
    // Untied it is posted once through its minutes, and takes no key.
    const pane = live(`reader-${version}.pane-open.txt`);
    const untied = permission(pane);
    assert.deepEqual([untied.toolUseId, untied.terminalWhy, untied.entry], [undefined, 'unbound', 'reader']);
    assert.equal(dialogSig(untied), dialogSig(permission(pane.replace('about 2 minutes', 'about 1 minute'))));
    assert.notEqual(requestKey(untied), requestKey(permission(live(`reader-${version}.pane-typed.txt`))));
    // Tied to its call, the clock is no part of it.
    assert.equal(dialogSig(open), dialogSig(permission(pane.replace('about 2 minutes', 'about 1 minute'), reader)));
  }
  // A dialog without a command box (or the quoted block): searched from its
  // title down. With rows that end in the notice it is a prompt under a
  // countdown, which — no call is ever tied to such a dialog — takes no key and
  // is one post through its ticks. (PR #17: not searched; the clock was a row
  // like any other, so it was reposted per tick, and an answer that found the
  // clock reading what the post showed was passed on.)
  const unboxed = PERMISSION.replace(' Do you want to proceed?', ' ⚠ Claude Code will automatically block this request in 1:59, to avoid holding up an unattended session\n\n Do you want to proceed?');
  assert.equal(permission(PERMISSION).requiresTerminal, undefined);
  assert.equal(permission(unboxed).expiry?.seconds, 119);
  assert.equal(permission(unboxed).terminalWhy, 'unbound');
  assert.equal(dialogSig(permission(unboxed)), dialogSig(permission(unboxed.replace('1:59', '1:58'))));
  assert.notEqual(dialogSig(permission(unboxed)), dialogSig(permission(PERMISSION)));
});

test('which post it is: the same identity under a countdown that ends at another time is the request asked again — for every kind of prompt', () => {
  const read = (pane: string, open: OpenToolUse[], readAt: number): PendingQ => {
    const d = stampExpiry(parseDialogPane(pane, open), readAt);
    assert.equal(d.kind, 'question');
    return d.q;
  };
  const t0 = 1_800_000_000_000;
  const twins = [bash(BOXED_COMMAND, 'a'), bash(BOXED_COMMAND, 'b')];
  for (const [what, open, why] of [['untied', [], 'unbound'], ['two fitting calls', twins, 'lookalike'], ['tied', [bash(BOXED_COMMAND)], undefined]] as const) {
    const at = (clock: string, ms: number) => read(BOXED.replace('1:59', clock), [...open], t0 + ms);
    const posted = at('1:59', 0);
    assert.equal(posted.terminalWhy, why, what);
    assert.equal(posted.expiry?.at, t0 + 119_000);
    const card = { sig: dialogSig(posted), questions: [posted] };
    // 20 s on, the clock reads 1:39 (give or take the second it shows): the
    // post's prompt still — nothing to post again. (Whether it takes a KEY is
    // not this: the two that no call identifies take none at any tick.)
    for (const clock of ['1:39', '1:40', '1:38']) assert.equal(sameDialog(card, at(clock, 20_000)), true, `${what} ${clock}`);
    assert.equal(sameDialog(card, at('1:57', 0)), true, what);
    // Blocked and asked again: the clock is back at 1:59, or reads what a
    // countdown started 10 s later would. A new post — and for the tied one,
    // whose call id would have vouched for it, no key on the old.
    assert.equal(sameDialog(card, at('1:59', 20_000)), false, what);
    assert.equal(sameDialog(card, at('1:49', 20_000)), false, what);
    assert.equal(sameDialog(card, at('1:55', 0)), false, what);
    // A post made with no notice on screen (or by a build that did not read
    // it): the notice that is there now was not — posted anew.
    assert.equal(sameDialog({ sig: card.sig, questions: [{ ...posted, expiry: undefined }] }, at('1:59', 60_000)), false, what);
    // The notice gone (a key at the terminal dropped it) is no ground to refuse:
    // a tied prompt is its call's still. (The untied one reads as another
    // prompt then — one that takes an answer by its rows.)
    const bare = (() => {
      const rows = BOXED.split('\n');
      const from = rows.findIndex((row) => row.includes('will automatically block this request in 1:59'));
      return read([...rows.slice(0, from), ...rows.slice(from + posted.expiry!.rows[1] - posted.expiry!.rows[0])].join('\n'), [...open], t0 + 30_000);
    })();
    assert.equal(bare.expiry, undefined);
    assert.equal(sameDialog(card, bare), what !== 'untied', what);
  }
  // Two fitting calls with no place in a queue: the post is the same one with
  // the notice gone (a key at the terminal dropped it) — as on PR #17.
  const both = permission(BOXED, twins);
  assert.deepEqual(both.lookalikes, ['a', 'b']);
  const rows = BOXED.split('\n');
  const at = rows.findIndex((row) => row.includes('will automatically block this request in 1:59'));
  const [from, to] = both.expiry!.rows;
  assert.equal(dialogSig(both), dialogSig(permission([...rows.slice(0, at), ...rows.slice(at + to - from)].join('\n'), twins)));
});

test('ordinary untimed permission prompts keep their detail and options', () => {
  const pane = fixture('permission-untimed-create');
  const q = permission(pane, [bash('note.txt')]);
  assert.equal(q.title, 'Create file');
  assert.equal(q.toolUseId, undefined);
  assert.equal(q.requiresTerminal, undefined);
  assert.equal(q.options[0]?.label, 'Yes');
  assert.match(q.options[1]?.label ?? '', /^Yes, and switch to accept edits/);
  assert.equal(q.options[2]?.label, 'No');
  assert.match(q.detail!, /note\.txt\n╌+\n  1 Example paragraph one\.\n  2 Example paragraph two\./);
  assert.notEqual(dialogSig(q), dialogSig(permission(pane.replace('paragraph two', 'paragraph three'))));
});

test('an ordinary screen is no dialog', () => {
  assert.equal(parseDialogPane('> hello\n  ? for shortcuts').kind, 'none');
});
