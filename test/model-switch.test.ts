import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveModelSwitcher, normalizeModel, parseModelMenu, reasoningKeys } from '../src/model-switch.js';
import { parseCommand } from '../src/commands.js';
import type { Tmux } from '../src/tmux.js';
import { CLAUDE_CONFIRM, CLAUDE_CHANGED, CODEX_MODELS, CODEX_REASONING, CODEX_CHANGED } from './model-fixtures.js';

/** Each pane is a post-transition capture; an exhausted script stays on the
 * last screen so timeouts and unexpected screens are exercised without clocks. */
function scripted(panes: string[]) {
  let index = 0;
  let escaped = false;
  const keys: string[][] = [];
  const text: string[] = [];
  const tmux = {
    async capturePane() { return escaped ? 'Ask Codex to do anything\n? for shortcuts' : panes[Math.min(index++, panes.length - 1)]; },
    async sendKeys(_s: string, ...k: string[]) { keys.push(k); if (k.includes('Escape')) escaped = true; },
    async sendText(_s: string, s: string) { text.push(s); escaped = false; },
  } as unknown as Tmux;
  return { tmux, keys, text, switcher: new LiveModelSwitcher(tmux, async () => {}) };
}

test('model grammar: aliases, target forms, effort, listing, invalid input', () => {
  assert.deepEqual(parseCommand('model scout opus55'), { kind: 'model', target: 'scout', model: 'claude-opus-5-5', effort: undefined });
  assert.deepEqual(parseCommand('model [cx-gpt-6-sol] Scout gpt-6.1-terra effort=medium'), {
    kind: 'model', target: '[cx-gpt-6-sol] Scout', model: 'gpt-6.1-terra', effort: 'medium',
  });
  assert.equal(parseCommand('model scout').kind, 'model');
  assert.equal(parseCommand('model scout effort=high').kind, 'model');
  for (const bad of ['model', 'model scout opus', 'model scout gpt-6-sol effort=ultracode', 'model scout effort=nope', 'model scout effort=', 'model scout a b', 'model scout x=1']) {
    assert.equal(parseCommand(bad).kind, 'help', bad);
  }
});

test('real Claude 2.1.306 model confirmation fixture', () => {
  const menu = parseModelMenu(CLAUDE_CONFIRM, 'claude')!;
  assert.equal(menu.kind, 'confirm');
  assert.deepEqual(menu.options.map(o => o.label), ['Yes, switch to Opus 5.5', 'No, go back']);
});

test('real Codex 0.166.0 scrolling model list, mixed display spellings', () => {
  const m = parseModelMenu(CODEX_MODELS, 'codex')!;
  assert.equal(m.kind, 'models');
  assert.equal(m.more, true);
  assert.equal(m.options.length, 8);
  assert.equal(m.options[5].model, 'gpt-6.1-terra');
  assert.equal(m.options[0].model, 'gpt-6.1-sol');
  assert.equal(normalizeModel('GPT-6.1 Terra'), normalizeModel('gpt-6.1-terra'));
  const r = parseModelMenu(CODEX_REASONING, 'codex')!;
  assert.equal(r.kind, 'reasoning');
  assert.deepEqual(reasoningKeys(r, 'medium'), ['Down', 's']);
  assert.deepEqual(reasoningKeys(r, 'xhigh'), ['Down', 'Down', 'Down', 's']);
  assert.deepEqual(reasoningKeys(r), ['s']);
  assert.equal(reasoningKeys(r, 'ultra'), undefined);
});

test('Claude sends /model id, verifies Yes target, confirms actual model', async () => {
  const f = scripted(['? for shortcuts', CLAUDE_CONFIRM, CLAUDE_CHANGED]);
  assert.deepEqual(await f.switcher.run('cc-scout', 'claude', 'claude-opus-5-5'), { kind: 'switched', model: 'claude-opus-5-5' });
  assert.deepEqual(f.text, ['/model claude-opus-5-5']);
  assert.deepEqual(f.keys, [['Enter'], ['1']]);
});

test('Claude immediate set-model confirmation is supported', async () => {
  const f = scripted(['? for shortcuts', CLAUDE_CHANGED]);
  assert.equal((await f.switcher.run('cc-scout', 'claude', 'claude-opus-5-5')).kind, 'switched');
});

for (const [name, pane] of [['wrong target', CLAUDE_CONFIRM.replaceAll('Opus 5.5', 'Sonnet 5.5')], ['unexpected', 'unknown screen']] as const) {
  test(`Claude ${name}: no confirmation sent, Escape on exit`, async () => {
    const f = scripted(['? for shortcuts', pane]);
    await assert.rejects(f.switcher.run('s', 'claude', 'claude-opus-5-5'));
    assert.deepEqual(f.keys, [['Enter'], ['Escape']]);
  });
}

test('Claude missing success confirmation Escapes and reports timeout', async () => {
  const f = scripted(['? for shortcuts', CLAUDE_CONFIRM, '? for shortcuts']);
  await assert.rejects(f.switcher.run('s', 'claude', 'claude-opus-5-5'), /timed out/);
  assert.deepEqual(f.keys.at(-1), ['Escape']);
});

test('Claude list uses a snapshot and closes menu; live effort fails before typing', async () => {
  const pane = 'Select model\n❯ 1. Opus 5.5\n  2. Sonnet 5.5'; // synthetic: no captured Claude list supplied
  const f = scripted(['? for shortcuts', pane]);
  const result = await f.switcher.run('s', 'claude');
  assert.equal(result.kind, 'menu');
  assert.deepEqual(f.keys.at(-1), ['Escape']);
  const g = scripted(['? for shortcuts']);
  await assert.rejects(g.switcher.run('s', 'claude', 'claude-opus-5-5', 'high'), /stop and spawn/);
  assert.deepEqual(g.text, []);
});

for (const [effort, keys, actual] of [
  ['medium', ['Down', 's'], 'medium'], ['xhigh', ['Down', 'Down', 'Down', 's'], 'xhigh'],
  [undefined, ['s'], 'low'], ['default', ['s'], 'low'],
] as const) test(`Codex applies ${effort ?? 'omitted/default'} with arrows and session-only s`, async () => {
  const f = scripted(['Ask Codex to do anything', CODEX_MODELS, CODEX_REASONING, CODEX_CHANGED.replace('medium', actual)]);
  assert.deepEqual(await f.switcher.run('s', 'codex', 'gpt-6.1-terra', effort), { kind: 'switched', model: 'gpt-6.1-terra', effort: actual });
  assert.deepEqual(f.text, ['/model']);
  assert.deepEqual(f.keys, [['Enter'], ['6'], [...keys]]);
  assert.ok(!f.keys.slice(2).flat().includes('Enter'));
});

test('Codex expanded max/ultra reasoning submenu is verified (synthetic fixture)', async () => {
  const more = 'Select Reasoning Level for GPT-6.1 Terra\n› 1. Max\n  2. Ultra';
  const f = scripted(['Ask Codex to do anything', CODEX_MODELS, CODEX_REASONING, more, CODEX_CHANGED.replace('medium', 'ultra')]);
  assert.equal((await f.switcher.run('s', 'codex', 'gpt-6.1-terra', 'ultra')).kind, 'switched');
  assert.deepEqual(f.keys[2], ['Down', 'Down', 'Down', 'Down', 'Enter']);
  assert.deepEqual(f.keys[3], ['Down', 's']);
});

for (const model of [undefined, 'gpt-absent']) test(`Codex ${model ?? 'list'} closes menu for numeric fallback`, async () => {
  const f = scripted(['Ask Codex to do anything', CODEX_MODELS]);
  assert.equal((await f.switcher.run('s', 'codex', model)).kind, 'menu');
  assert.deepEqual(f.keys, [['Enter'], ['Escape'], ['Escape']]);
});

for (const [name, panes] of [
  ['wrong reasoning model', [CODEX_MODELS, CODEX_REASONING.replace('GPT-6.1 Terra', 'GPT-6-Sol')]],
  ['unsupported effort', [CODEX_MODELS, CODEX_REASONING]],
  ['unconfirmed switch', [CODEX_MODELS, CODEX_REASONING, 'Ask Codex to do anything']],
  ['wrong confirmed effort', [CODEX_MODELS, CODEX_REASONING, CODEX_CHANGED.replace('medium', 'low')]],
  ['wrong confirmed model', [CODEX_MODELS, CODEX_REASONING, CODEX_CHANGED.replace('terra', 'sol')]],
  ['unexpected screen', ['something unexpected']],
] as const) test(`Codex ${name}: unwind every menu and retain old model`, async () => {
  const f = scripted(['Ask Codex to do anything', ...panes]);
  await assert.rejects(f.switcher.run('s', 'codex', 'gpt-6.1-terra', name === 'unsupported effort' ? 'minimal' : 'medium'));
  assert.deepEqual(f.keys.slice(-2), [['Escape'], ['Escape']]);
});

test('existing model dialogs are cancelled, busy/unrecognised prompts are not typed into', async () => {
  const f = scripted([CODEX_MODELS]);
  await assert.rejects(f.switcher.run('s', 'codex', 'gpt-6.1-terra'), /already on screen/);
  assert.deepEqual(f.keys, [['Escape'], ['Escape']]);
  const g = scripted(['working...']);
  await assert.rejects(g.switcher.run('s', 'codex', 'gpt-6.1-terra'), /idle prompt/);
  assert.deepEqual(g.text, []);
});

test('tmux failure still attempts Escape cleanup', async () => {
  const f = scripted(['? for shortcuts']);
  f.tmux.sendText = async () => { throw new Error('send failed'); };
  await assert.rejects(f.switcher.run('s', 'claude', 'claude-opus-5-5'), /send failed/);
  assert.deepEqual(f.keys, [['Escape']]);
});

for (const engine of ['claude', 'codex'] as const) test(`${engine} old confirmation in scrollback is not fresh switch evidence`, async () => {
  const changed = engine === 'claude' ? CLAUDE_CHANGED : CODEX_CHANGED;
  const ready = engine === 'claude' ? '? for shortcuts' : 'Ask Codex to do anything';
  const panes = engine === 'claude' ? [CLAUDE_CONFIRM, changed] : [CODEX_MODELS, CODEX_REASONING, changed];
  const f = scripted([changed + '\n' + ready, ...panes]);
  await assert.rejects(f.switcher.run('s', engine, engine === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-terra', engine === 'codex' ? 'medium' : undefined), /timed out/);
  assert.ok(f.keys.flat().includes('Escape'));
});

test('Codex picks displayed model identity rather than a remembered ordinal', async () => {
  const reordered = CODEX_MODELS.replace('6. GPT-6.1 Terra', '9. GPT-6.1 Terra');
  const f = scripted(['Ask Codex to do anything', reordered, CODEX_REASONING, CODEX_CHANGED]);
  await f.switcher.run('s', 'codex', 'gpt-6.1-terra', 'medium');
  assert.deepEqual(f.keys[1], ['9']);
});

test('stuck menu cleanup fails loudly rather than claiming to have closed it', async () => {
  const f = scripted(['Ask Codex to do anything', CODEX_MODELS]);
  let first = true;
  f.tmux.capturePane = async () => {
    if (first) { first = false; return 'Ask Codex to do anything'; }
    return CODEX_MODELS;
  };
  await assert.rejects(f.switcher.run('s', 'codex'), /could not dismiss/);
  assert.equal(f.keys.flat().filter(k => k === 'Escape').length, 4);
});
