import { join, dirname } from 'node:path';
import type { SpawnerConfig } from './config.js';
import type { AgentHost } from './host.js';
import type { Tmux } from './tmux.js';
import { shq, type LaunchRequest } from './launcher.js';
import { handPaths, renderBridgeConfig } from './handfiles.js';

export const inferEngine = (model: string): 'codex' | 'claude' => /^gpt-/i.test(model) ? 'codex' : 'claude';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Startup/MCP override approach adapted from anima-research/cc-spawner
 * f7030a7e, Copyright 2026 antra-tess (MIT; see NOTICE). */
export function codexArgs(cfg: SpawnerConfig, req: LaunchRequest): string[] {
  const p = handPaths(cfg.handsDir, req.tmuxSession, dirname(req.bridgeConfig));
  const transport = (renderBridgeConfig(cfg, req.tmuxSession, req.streamName, p, req.workDir) as {
    servers: { zulip: { transport: { command: string; args: string[]; env: Record<string, string> } } };
  }).servers.zulip.transport;
  const env = { ...transport.env, HOME: cfg.agentsHome, MCPL_ENABLED: 'false' };
  const args = req.resume && req.sessionId ? ['resume'] : [];
  args.push('--dangerously-bypass-approvals-and-sandbox', `--model=${req.model}`);
  if (req.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(req.effort)}`);
  args.push('-c', `mcp_servers.zulip.command=${JSON.stringify(transport.command)}`,
    '-c', `mcp_servers.zulip.args=${JSON.stringify(transport.args)}`,
    '-c', `mcp_servers.zulip.env={${Object.entries(env).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(',')}}`);
  args.push('--');
  if (req.resume && req.sessionId) args.push(req.sessionId);
  return args;
}

export function codexCommand(cfg: SpawnerConfig, req: LaunchRequest): string {
  return [
    ...(cfg.agentsEnvFile ? [`set -a && . ${shq(cfg.agentsEnvFile)} && set +a &&`] : []),
    `test -r ${shq(req.seedFile)} && exec env HOME=${shq(cfg.agentsHome)} CODEX_HOME=${shq(join(cfg.agentsHome, '.codex'))}`,
    shq(cfg.codexBin ?? 'codex'), ...codexArgs(cfg, req).map(shq), `"$(cat ${shq(req.seedFile)})"`,
  ].join(' ');
}

/** Self-contained so discovery can run as the agents user, not the spawner.
 * Refuse ambiguous matches rather than guessing the newest unrelated file. */
export function discoverRollout(root: string, since: number, cwd: string): string | undefined {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const ids = new Set<string>();
  const canonical = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
  const visit = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) { visit(file); continue; }
      if (!/^rollout-.*\.jsonl$/.test(e.name)) continue;
      try {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(65536);
        let n: number;
        try { n = fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
        const meta = JSON.parse(buf.subarray(0, n).toString().split('\n')[0]);
        const p = meta.payload;
        if (meta.type === 'session_meta' && canonical(p.cwd) === canonical(cwd) &&
            Date.parse(p.timestamp ?? meta.timestamp) >= since &&
            /^[0-9a-f-]{36}$/i.test(p.id)) ids.add(p.id);
      } catch { /* partial rollout: retry next poll */ }
    }
  };
  visit(root);
  return ids.size === 1 ? [...ids][0] : undefined;
}

export function codexScreen(pane: string): 'login' | 'trust' | 'deprecated' | 'enter' | 'ready' | 'unknown' {
  if (/Sign in with ChatGPT|codex login/i.test(pane)) return 'login';
  if (/trust.*(?:directory|folder)|Do you trust|Is this a project you created or one you trust/i.test(pane)) return 'trust';
  if (/Use existing model/i.test(pane)) return 'deprecated';
  if (/Press enter to continue/i.test(pane)) return 'enter';
  return /permissions: YOLO mode|Ask Codex to do anything|^\s*›\s/m.test(pane) ? 'ready' : 'unknown';
}

export class CodexLauncher {
  constructor(private cfg: SpawnerConfig, private tmux: Tmux, private host: AgentHost) {}
  async launch(req: LaunchRequest): Promise<{ sessionId?: string; warning?: string }> {
    const start = Date.now();
    const cwd = req.workDir ?? this.cfg.projectDir;
    await this.tmux.newSession(req.tmuxSession, cwd, codexCommand(this.cfg, req));
    let ready = false;
    for (let i = 0; i < 45; i++) {
      if (!await this.tmux.hasSession(req.tmuxSession)) throw new Error('Codex exited during startup.');
      const screen = codexScreen(await this.tmux.capturePane(req.tmuxSession));
      if (screen === 'login') throw new Error('Codex needs login; an operator must authenticate the agents user before retrying.');
      if (screen === 'ready') { ready = true; break; }
      if (screen === 'deprecated') await this.tmux.sendKeys(req.tmuxSession, 'Down', 'Enter');
      if (screen === 'trust' || screen === 'enter') await this.tmux.sendKeys(req.tmuxSession, 'Enter');
      await sleep(2000);
    }
    if (!ready) throw new Error('Codex startup timed out after 90 seconds.');
    if (req.resume && req.sessionId) return { sessionId: req.sessionId };
    for (let i = 0; i < 23; i++) {
      const { stdout } = await this.host.exec(this.cfg.nodeBin, ['-e',
        `const __name=(f)=>f; console.log((${discoverRollout.toString()})(...JSON.parse(process.argv[1])) ?? '')`,
        JSON.stringify([join(this.cfg.agentsHome, '.codex/sessions'), start, cwd])]);
      if (stdout.trim()) return { sessionId: stdout.trim() };
      await sleep(2000);
    }
    return { sessionId: '', warning: 'Codex session id unavailable: mention-wake is disabled; revival will start fresh.' };
  }
}

export const QUEUE_FAILURE = 'Could not wake the Codex hand. Please retry or ask an operator to inspect it.';
export const queueArgs = (id: string, message: string) => [`--thread=${id}`, `--message=${message}`];
/** execFile end-to-end: text is data, including leading dashes. Source only the
 * operator-configured env file, separately from execution of the queue argv. */
export async function queueCodex(host: AgentHost, cfg: SpawnerConfig, id: string, message: string): Promise<void> {
  const script = `const {execFileSync}=require('node:child_process');
const [bin,args,home,envFile]=JSON.parse(process.argv[1]);
let env={...process.env};
if(envFile) { const raw=execFileSync('bash',['-c','set -a && . "$1" && env -0','bash',envFile],{encoding:'utf8'}); for(const item of raw.split('\\0')) { const n=item.indexOf('='); if(n>0) env[item.slice(0,n)]=item.slice(n+1); } }
env.HOME=home; env.CODEX_HOME=home+'/.codex';
execFileSync(bin,['queue',...args],{env,timeout:30000,stdio:['ignore','pipe','pipe']});`;
  await host.exec(cfg.nodeBin, ['-e', script, JSON.stringify([cfg.codexBin ?? 'codex', queueArgs(id, message), cfg.agentsHome, cfg.agentsEnvFile])]);
}
