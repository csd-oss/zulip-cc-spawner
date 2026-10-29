/**
 * Thin async wrappers around the tmux CLI, run as the agents user (AgentHost),
 * on the agents' tmux server (optionally a fixed socket, see config.tmuxSocket).
 *
 * "Session absent" is decided only from tmux's own answers ("can't find
 * session", "no server running", …). Anything else — sudo refusing, tmux
 * missing, a permission error on the socket — is an infrastructure failure and
 * propagates: treating it as "absent" would mark live hands dead, or report a
 * kill that never happened.
 */
import type { AgentHost } from './host.js';

// "server exited unexpectedly": the server quit because its last session just
// ended (default exit-empty) — no server, hence no session. "no current target":
// tmux 3.2a (RHEL 9) resolving `=name` on a running server with no sessions.
const ABSENT_RE = /can't find session|can't find pane|session not found|no server running|server exited unexpectedly|no current target|error connecting to .*\((No such file or directory|Connection refused)\)/i;

export function isAbsentError(err: unknown): boolean {
  const e = err as { stderr?: string | Buffer; message?: string };
  return ABSENT_RE.test(`${e?.stderr ?? ''} ${e?.message ?? ''}`);
}

export class Tmux {
  constructor(
    private readonly host: AgentHost,
    private readonly socket?: string,
  ) {}

  private tmux(args: string[]): Promise<{ stdout: string }> {
    return this.host.exec('tmux', this.socket ? ['-S', this.socket, ...args] : args);
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.tmux(['has-session', '-t', `=${name}`]);
      return true;
    } catch (err) {
      if (isAbsentError(err)) return false;
      throw err;
    }
  }

  /** Create a detached session running `command` (via the user's shell -c) in `cwd`. */
  async newSession(name: string, cwd: string, command: string): Promise<void> {
    await this.tmux(['new-session', '-d', '-s', name, '-c', cwd, command]);
  }

  /** Kill and confirm. Absent already counts as killed; anything else throws. */
  async killSession(name: string): Promise<void> {
    try {
      await this.tmux(['kill-session', '-t', `=${name}`]);
    } catch (err) {
      if (!isAbsentError(err)) throw err;
    }
    if (await this.hasSession(name)) throw new Error(`tmux session ${name} is still there after kill-session`);
  }

  // NB: pane-target contexts (capture-pane, send-keys) need `=name:` — the bare
  // `=name` exact-match form only parses in session-target contexts (upstream,
  // verified on tmux 3.6a).
  async capturePane(name: string, scrollbackLines = 0): Promise<string> {
    const args = ['capture-pane', '-p'];
    if (scrollbackLines > 0) args.push('-S', `-${scrollbackLines}`);
    args.push('-t', `=${name}:`);
    const { stdout } = await this.tmux(args);
    return stdout;
  }

  /** Seconds since the session was created. */
  async sessionUptime(name: string): Promise<number | undefined> {
    try {
      const { stdout } = await this.tmux(['display', '-p', '-t', `=${name}:`, '#{session_created}']);
      const created = Number(stdout.trim());
      return Number.isFinite(created) ? Math.max(0, Math.floor(Date.now() / 1000 - created)) : undefined;
    } catch {
      return undefined;
    }
  }

  async sendKeys(name: string, ...keys: string[]): Promise<void> {
    await this.tmux(['send-keys', '-t', `=${name}:`, ...keys]);
  }

  /** Literal text (no key-name interpretation — `-l`). */
  async sendText(name: string, text: string): Promise<void> {
    await this.tmux(['send-keys', '-t', `=${name}:`, '-l', text]);
  }

  async listSessions(): Promise<string[]> {
    try {
      const { stdout } = await this.tmux(['list-sessions', '-F', '#{session_name}']);
      return stdout.split('\n').filter(Boolean);
    } catch (err) {
      if (isAbsentError(err)) return []; // no server ⇒ no sessions
      throw err;
    }
  }
}
