import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { handPaths, renderBridgeConfig } from '../src/handfiles.js';
import { testConfig, tmp } from './helpers.js';

test('bridge exports exactly the absolute workspace as work, with no other config changes', () => {
  const cfg = testConfig(tmp());
  const p = handPaths(cfg.handsDir, 'cc-scout');
  const workDir = join(cfg.projectDir, 'hands', 'cc-scout');
  const bridge = JSON.parse(JSON.stringify(renderBridgeConfig(cfg, 'cc-scout', 'home', p, workDir)));
  assert.equal(bridge.servers.zulip.transport.env.ZULIP_UPLOAD_ROOTS, `work=${workDir}`);
  delete bridge.servers.zulip.transport.env.ZULIP_UPLOAD_ROOTS;
  assert.deepEqual(bridge, renderBridgeConfig(cfg, 'cc-scout', 'home', p));
});

test('unknown workspace fails closed: never infer an upload root from projectDir or HandPaths', () => {
  const cfg = testConfig(tmp());
  const p = handPaths(cfg.handsDir, 'cc-scout');
  for (const workDir of [undefined, '', 'relative/work']) {
    const bridge = JSON.parse(JSON.stringify(renderBridgeConfig(cfg, 'cc-scout', 'home', p, workDir)));
    assert.equal(Object.hasOwn(bridge.servers.zulip.transport.env, 'ZULIP_UPLOAD_ROOTS'), false);
  }
});

test('private paths cannot become an upload root, even through ancestor/descendant overlap', () => {
  const cfg = testConfig(tmp());
  const p = handPaths(cfg.handsDir, 'cc-scout', join(cfg.projectDir, 'legacy-private'));
  for (const workDir of [cfg.projectDir, cfg.handsDir, join(cfg.handsDir, 'other-hand'),
    p.dir, p.stateDir, join(p.dir, '..', 'legacy-private', 'nested')]) {
    const bridge = JSON.parse(JSON.stringify(renderBridgeConfig(cfg, 'cc-scout', 'home', p, workDir)));
    assert.equal(Object.hasOwn(bridge.servers.zulip.transport.env, 'ZULIP_UPLOAD_ROOTS'), false, workDir);
  }
});
