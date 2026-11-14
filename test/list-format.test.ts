import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listActivity, listCode, listHome, listText, relativeActivity } from '../src/list-format.js';

const now = Date.parse('2026-11-14T12:00:00Z');
test('relative activity: boundaries, missing/invalid dates and clock skew', () => {
  for (const [seconds, expected] of [[0, 'just now'], [59, 'just now'], [60, '1 min ago'], [3599, '59 min ago'], [3600, '1 h ago'], [86399, '23 h ago'], [86400, '1 d ago'], [864000, '10 d ago'], [-3600, 'just now']] as const) {
    assert.equal(relativeActivity(new Date(now - seconds * 1000).toISOString(), now), expected);
  }
  for (const value of [undefined, '', 'invalid']) assert.equal(relativeActivity(value, now), 'activity unknown');
});

test('homes: native Zulip links, missing fields and escaped explicit narrows', () => {
  assert.equal(listHome({ streamId: 7, streamName: 'hands', topic: 'home topic' }), '#**hands>home topic**');
  assert.equal(listHome({ streamId: 7, streamName: 'hands', topic: '' }), '#**hands**');
  assert.equal(listHome({ streamId: 0, streamName: '', topic: '' }), 'home unknown');
  const topic = 'a > **b** [x](y) / café. [[msg:123]]';
  const output = listHome({ streamId: 7, streamName: 'hands', topic });
  const fragment = output.match(/\]\(#narrow\/stream\/7\/topic\/(.*)\)$/)![1];
  assert.equal(decodeURIComponent(fragment.replace(/\./g, '%')), topic);
  assert.ok(!output.includes('[[msg:'));
  assert.ok(!listText('[[msg:123]]\n* injected').includes('[[msg:'));
  assert.ok(!listText('a\nb').includes('\n'));
  assert.equal(listHome({ streamId: 7, streamName: '', topic: 'a' }), '[&#35;unknown stream &#62; a](#narrow/stream/7/topic/a)');
});

for (const topic of ['pipes | divide', 'under_score', '`code`', 'line\nbreak', 'back\\slash', '[link](https://example.test)']) {
  test(`table home escapes delimiters: ${JSON.stringify(topic)}`, () => {
    const output = listHome({ streamId: 7, streamName: 'hands', topic });
    assert.match(output, /#narrow\/stream\/7\/topic\//);
    assert.equal(output.split('|').length, 1);
    assert.ok(!output.includes('\\'), 'Zulip shows backslash escapes literally');
    assert.ok(!output.includes('\n'));
    const fragment = output.match(/\]\(#narrow\/stream\/7\/topic\/(.*)\)$/)![1];
    assert.equal(decodeURIComponent(fragment.replace(/\./g, '%')), topic);
  });
}

// Zulip has no backslash-escape pattern; what it does decode is numeric references.
const decode = (s: string) => s.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
// Everything Zulip's inline/table syntax keys on, outside of the `&#NN;` form itself.
const MARKUP = /[\\`*_{}[\]()<>!|~$:@]|&(?!#\d+;)|#(?<!&#)/;

const hostile = [
  'cost $$x^2$$ here', 'a ~~struck~~ b', 'at <time:2026-11-14T12:00:00Z>', '@**all** @_**Vasyl**', ':smile: :)',
  'a | b \\| c', '`code` and ``more``', 'back\\slash \\*x\\*', 'html &amp; &#42; &lt;b&gt;', '[[msg:123]] [x](y) ![i](j)',
  '#**s>t** #**s>t@123**', 'line\nbreak\r\ttab', 'nel\u0085ls\u2028ps\u2029end', '{x} ~ $ single', 'https://example.test/a_b',
];
for (const value of hostile) test(`listText renders cleanly without backslashes: ${JSON.stringify(value)}`, () => {
  const output = listText(value);
  assert.doesNotMatch(output, MARKUP, output);
  assert.ok(!/[\r\n\u0085\u2028\u2029\t]/.test(output));
  assert.equal(decode(output), value.replace(/[\s\u0085]+/g, ' '), 'renders as the original text');
});

test('table cells built from hostile text keep their column count without escapes', () => {
  const row = `| ${hostile.map(listText).join(' | ')} |`;
  assert.equal(row.split('|').length, hostile.length + 2);
  assert.ok(!row.includes('\\'));
});

for (const topic of ['cost $$x$$', 'ping @**all**', 'reply@123', 'a &amp; b', 'tab\there', 'nel\u0085x', 'ls\u2028x']) {
  test(`home falls back to an explicit narrow for Zulip-significant topic ${JSON.stringify(topic)}`, () => {
    const output = listHome({ streamId: 7, streamName: 'hands', topic });
    const [, label, fragment] = output.match(/^\[(.*)\]\(#narrow\/stream\/7\/topic\/(.*)\)$/)!;
    assert.doesNotMatch(label, MARKUP);
    assert.equal(decode(label), `#hands > ${topic.replace(/[\s\u0085]+/g, ' ')}`);
    assert.equal(decodeURIComponent(fragment.replace(/\./g, '%')), topic);
  });
}

test('homes stay native when only harmless punctuation is present', () => {
  for (const topic of ['v2 ~ notes', 'a: b', 'deploy #3', 'x.y-z (draft)']) {
    assert.equal(listHome({ streamId: 7, streamName: 'hands', topic }), `#**hands>${topic}**`);
  }
  assert.equal(listHome({ streamId: 0, streamName: 'odd $$s$$', topic: '' }), '&#35;odd &#36;&#36;s&#36;&#36;');
});

test('activity: relative first, absolute UTC after the first hour', () => {
  const at = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(listActivity(at(0), now), 'just now');
  assert.equal(listActivity(at(59 * 60_000), now), '59 min ago');
  assert.equal(listActivity(at(3600_000), now), '1 h ago (2026-11-14 11:00 UTC)');
  assert.equal(listActivity(at(10 * 86400_000 + 90_000), now), '10 d ago (2026-11-04 11:58 UTC)');
  assert.equal(listActivity(at(-3600_000), now), 'just now', 'clock skew shows no future absolute time');
  for (const value of [undefined, '', 'invalid']) assert.equal(listActivity(value, now), 'activity unknown');
});

test('generated command targets stay copyable code; anything else is plain text', () => {
  for (const target of ['scout', 'cc-opus-5-5-scout', 'hand:cc-Scout%2Ex%5Fy%7Ez']) assert.equal(listCode(target), `\`${target}\``);
  assert.equal(listCode('a`b|c'), 'a&#96;b&#124;c');
});
