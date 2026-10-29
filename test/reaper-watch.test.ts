import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { LocalHost } from '../src/host.js';
import type { Notifier } from '../src/notifier.js';
import { Reaper, SILENCE_WARN_MS } from '../src/reaper.js';
import { Registry, type BotEntry } from '../src/registry.js';
import type { Tmux } from '../src/tmux.js';
import { TranscriptWatcher, transcriptPath } from '../src/transcript-watch.js';
import { tmp } from './helpers.js';

class FakeTmux {
  sessions = new Set<string>();
  panes = new Map<string, string>();
  keys: string[] = [];
  failHas = false;
  async hasSession(n: string) {
    if (this.failHas) throw new Error('sudo: a password is required');
    return this.sessions.has(n);
  }
  async killSession(n: string) {
    this.sessions.delete(n);
  }
  async listSessions() {
    return [...this.sessions];
  }
  async capturePane(n: string) {
    return this.panes.get(n) ?? '';
  }
  async sendKeys(n: string, ...k: string[]) {
    this.keys.push(`${n}:${k.join(' ')}`);
  }
}

class Posts implements Notifier {
  out: string[] = [];
  async postHome(_e: unknown, c: string) {
    this.out.push(c);
    return this.out.length;
  }
  async reply() {}
  async dm() {}
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function entry(over: Partial<BotEntry> = {}): BotEntry {
  return {
    suffix: 'scout', personaName: 'Claude-Code-opus-5-5-scout', botUserId: 100, botEmail: 'b@x', tmuxSession: 'cc-opus-5-5-scout',
    streamName: 'cc-hands', streamId: 7, topic: 't', handDir: '/x', model: 'claude-opus-5-5', sessionId: 'sess',
    spawnedBy: { userId: 1, username: 'Tester' }, spawnedAt: ago(1000), lastActivity: ago(1000), status: 'alive', seedFile: '/x/seed.md',
    firstPostAt: ago(900),
    ...over,
  };
}

function reaperSetup(e: BotEntry, lastPost: number | undefined) {
  const registry = new Registry(join(tmp(), 'r.json'));
  registry.add(e);
  const t = new FakeTmux();
  t.sessions.add(e.tmuxSession);
  const posts = new Posts();
  const reaper = new Reaper(registry, t as unknown as Tmux, posts, { inactivityMs: 3600_000 }, async () => lastPost);
  return { registry, t, posts, reaper };
}

test('reaper: a gone session is marked died with a notice', async () => {
  const s = reaperSetup(entry(), undefined);
  s.t.sessions.clear();
  await s.reaper.sweep();
  assert.equal(s.registry.all()[0].endReason, 'died');
  assert.match(s.posts.out[0], /exited on its own/);
});

test('reaper: tmux/sudo trouble is not death', async () => {
  const s = reaperSetup(entry(), undefined);
  s.t.failHas = true;
  await s.reaper.sweep();
  assert.equal(s.registry.all()[0].status, 'alive');
});

test('reaper: idle by our view but Zulip shows a recent post ⇒ kept', async () => {
  const s = reaperSetup(entry({ lastActivity: ago(2 * 3600_000) }), Date.now() - 60_000);
  await s.reaper.sweep();
  assert.equal(s.registry.all()[0].status, 'alive');
  assert.ok(Date.parse(s.registry.all()[0].lastActivity) > Date.now() - 120_000);
});

test('reaper: idle everywhere ⇒ reaped, identity kept', async () => {
  const s = reaperSetup(entry({ lastActivity: ago(2 * 3600_000) }), Date.now() - 3 * 3600_000);
  await s.reaper.sweep();
  assert.equal(s.registry.all()[0].endReason, 'reaped-idle');
  assert.equal(s.t.sessions.size, 0);
  assert.match(s.posts.out[0], /Reaping .* revives it/);
});

test('reaper: a hand silent since spawn gets one warning', async () => {
  const s = reaperSetup(entry({ spawnedAt: ago(SILENCE_WARN_MS + 60_000), firstPostAt: undefined }), undefined);
  await s.reaper.sweep();
  await s.reaper.sweep();
  assert.equal(s.posts.out.length, 1);
  assert.match(s.posts.out[0], /has not posted anything/);
});

test('reaper: reconcile closes out interrupted spawns and dead sessions', async () => {
  const s = reaperSetup(entry({ status: 'provisioning' }), undefined);
  s.registry.add(entry({ suffix: 'gone', tmuxSession: 'cc-gone' }));
  await s.reaper.reconcile();
  assert.equal(s.registry.all()[0].status, 'failed');
  assert.equal(s.registry.all()[1].endReason, 'died');
  assert.equal(s.posts.out.length, 0, 'reconcile is silent');
});

const PERMISSION_PANE = [
  '──────────────────────────────', ' Bash command', '   │ rm -rf "$X/build"', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Tab to amend',
].join('\n');

test('watcher: transcript events and dialogs are posted to the home topic', async () => {
  const dir = tmp();
  const registry = new Registry(join(dir, 'r.json'));
  const e = entry({ transcriptOffset: 0 });
  registry.add(e);
  const t = new FakeTmux();
  const posts = new Posts();
  const w = new TranscriptWatcher(registry, new LocalHost(), t as unknown as Tmux, posts, { agentsHome: join(dir, 'home'), projectDir: '/work/proj' }, () => 'CC Spawner');
  const path = transcriptPath(join(dir, 'home'), '/work/proj', 'sess');
  assert.equal(path, join(dir, 'home', '.claude', 'projects', '-work-proj', 'sess.jsonl'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [] } }),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 180000, postTokens: 20000 } }),
    JSON.stringify({ type: 'system', subtype: 'model_refusal_fallback' }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [] } }),
    '{"partial":',
  ].join('\n'));
  await w.sweep();
  assert.match(posts.out[0], /compacted \(auto\) — 180k → 20k tokens/);
  assert.match(posts.out[1], /Classifier fallback.*claude-sonnet-5-5.*was `claude-opus-5-5`/);
  const offset = registry.all()[0].transcriptOffset!;
  appendFileSync(path, '"line"}\n');
  await w.sweep();
  assert.ok(registry.all()[0].transcriptOffset! > offset, 'a partial line is read once it completes');

  t.panes.set(e.tmuxSession, PERMISSION_PANE);
  await w.sweep();
  assert.match(posts.out.at(-1)!, /permission prompt.*@\*\*CC Spawner\*\* answer scout 1/s);
  assert.equal(registry.all()[0].pendingQuestion?.questions[0].kind, 'permission');
  await w.sweep();
  const before = posts.out.length;
  t.panes.set(e.tmuxSession, '> idle');
  await w.sweep();
  assert.equal(posts.out.length, before + 1);
  assert.match(posts.out.at(-1)!, /permission prompt .* is resolved — answered in the terminal/);
  assert.equal(registry.all()[0].pendingQuestion, undefined);
});
