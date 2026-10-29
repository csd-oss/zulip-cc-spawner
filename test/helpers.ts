import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnerConfig } from '../src/config.js';

export function tmp(prefix = 'ccsp-'): string {
  // Short base: tmux sockets have a ~104-byte path limit on macOS.
  return mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), prefix));
}

/**
 * A stand-in for `claude`: records argv and the env vars we care about into
 * <dir>/<session-or-resume id>.json, optionally shows a startup screen first
 * (waiting for one keypress), then shows the ready status line and idles.
 */
export function fakeClaude(dir: string, screen: 'none' | 'api-key' | 'api-key-arrows' | 'bypass' = 'none'): string {
  const path = join(dir, 'fake-claude');
  const screens: Record<string, string> = {
    none: '',
    'api-key': `printf 'Detected a custom API key in your environment\\n Do you want to use this API key?\\n   1. Yes\\n ❯ 2. No (recommended)\\n'; IFS= read -r -n 1 k; echo "picked=$k" >> "${dir}/keys"; clear`,
    // 2.1.312: no digits; read keys until Enter, record them.
    'api-key-arrows': `printf 'Detected a custom API key in your environment\\n Do you want to use this API key?\\n   Yes\\n ❯ No (recommended)\\n Enter to confirm · Esc to cancel\\n'; ks=""; while IFS= read -r -s -n 1 k; do [ -z "$k" ] && break; ks="$ks$k"; done; printf '%s' "$ks" | od -An -c | tr -s ' ' >> "${dir}/keys"; clear`,
    bypass: `printf 'WARNING: Claude Code running in Bypass Permissions mode\\n ❯ 1. No, exit\\n   2. Yes, I accept\\n'; sleep 60`,
  };
  writeFileSync(
    path,
    `#!/usr/bin/env bash
id=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--session-id" ] || [ "$prev" = "--resume" ]; then id="$a"; fi
  prev="$a"
done
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1], JSON.stringify({argv: process.argv.slice(2), env: {MCPL_BRIDGE_CONFIG: process.env.MCPL_BRIDGE_CONFIG, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_CUSTOM_HEADERS: process.env.ANTHROPIC_CUSTOM_HEADERS, CLAUDE_CODE_EFFORT_LEVEL: process.env.CLAUDE_CODE_EFFORT_LEVEL}}))' "${dir}/run-$id.json" "$@"
${screens[screen]}
printf '\\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\\n'
sleep 600
`,
  );
  chmodSync(path, 0o755);
  return path;
}

export function testConfig(dir: string, overrides: Partial<SpawnerConfig> = {}): SpawnerConfig {
  const envFile = join(dir, 'agents.env');
  writeFileSync(envFile, 'ANTHROPIC_API_KEY=gate-token-from-env-file\nCLAUDE_CODE_EFFORT_LEVEL=low\n');
  return {
    spawnerRc: join(dir, 'spawner.zuliprc'),
    adminRc: join(dir, 'admin.zuliprc'),
    allowedStreams: ['cc-hands'],
    allowedUsers: [1],
    allowedGroups: [],
    allowedResidents: [],
    devMode: true,
    tmuxSocket: join(dir, 'tmux.sock'),
    maxSessions: 5,
    inactivityMs: 24 * 3600_000,
    reapIntervalMs: 600_000,
    watchIntervalMs: 20_000,
    projectDir: dir,
    agentsHome: join(dir, 'home'),
    handsDir: join(dir, 'hands'),
    agentsEnvFile: envFile,
    claudeBin: overrides.claudeBin ?? fakeClaude(dir),
    nodeBin: 'node',
    zulipMcp: '/opt/zulip_mcp/build/index.js',
    bridgePlugin: 'mcpl-bridge@mcpl-bridge-dev',
    attributionHeaders: { 'x-origin': 'cc-spawner', 'x-channel': '{hand}', 'x-counterparty': '{spawnedBy}' },
    handDmAllowlist: [],
    catchupLimit: 500,
    ...overrides,
  };
}
