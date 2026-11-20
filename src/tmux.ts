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
import { randomBytes } from 'node:crypto';
import type { AgentHost } from './host.js';

// "server exited unexpectedly": the server quit because its last session just
// ended (default exit-empty) — no server, hence no session. "no current target":
// tmux 3.2a (RHEL 9) resolving `=name` on a running server with no sessions.
const ABSENT_RE = /can't find session|can't find pane|session not found|no server running|server exited unexpectedly|no current target|error connecting to .*\((No such file or directory|Connection refused)\)/i;

export function isAbsentError(err: unknown): boolean {
  const e = err as { stderr?: string | Buffer; message?: string };
  return ABSENT_RE.test(`${e?.stderr ?? ''} ${e?.message ?? ''}`);
}

/** A pane of a session, as tmux has it. */
export interface SessionPane {
  /** `%7` — given to one pane for as long as the tmux server runs, and never
   *  to another: what is read from this id and what is sent to it meet the
   *  same pane, wherever it is moved and whichever pane is selected. */
  id: string;
  /** Its program has exited and the pane was kept (remain-on-exit). */
  dead: boolean;
  /** Its window has `synchronize-panes` on: tmux hands a key sent to this
   *  pane to every pane of the window. */
  synchronized: boolean;
  /** The command tmux started in it, as tmux prints it (quoted its way). */
  command: string;
}

/** Where a pane-level command goes: given a pane's id, to that pane and no
 *  other; given a session's name, to whichever pane of it is selected.
 *  NB: pane-target contexts need `=name:` — the bare `=name` exact-match form
 *  only parses in session-target contexts (upstream, verified on tmux 3.6a). */
const paneTarget = (target: string): string => (/^%\d+$/.test(target) ? target : `=${target}:`);

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

  /** Diagnostic pane inventory only; current session membership is not launch ownership. */
  async otherPaneRoots(excludedSessions: string[]): Promise<{pid: number; pane: string}[]> {
    try {
      const { stdout } = await this.tmux(['list-panes', '-a', '-F', '#{pane_pid} #{pane_id} #{session_name}']);
      return stdout.trim().split('\n').flatMap(line => {
        const match = /^(\d+) (%\d+) (.+)$/.exec(line);
        return match && !excludedSessions.includes(match[3]) ? [{pid: Number(match[1]), pane: match[2]}] : [];
      }).sort((a, b) => a.pid - b.pid);
    } catch (err) {
      if (isAbsentError(err)) return [];
      throw err;
    }
  }

  /** Create a detached session running `command` (via the user's shell -c) in
   *  `cwd`. `size`: its window's size — without one, tmux's `default-size`
   *  (80x24 as shipped). */
  async newSession(name: string, cwd: string, command: string, size?: { cols?: number; rows?: number }): Promise<void> {
    const args = ['new-session', '-d', '-s', name];
    if (size?.cols) args.push('-x', String(size.cols));
    if (size?.rows) args.push('-y', String(size.rows));
    await this.tmux([...args, '-c', cwd, command]);
  }

  /** Every pane of the session, in all its windows — and, asked for in that
   *  same tmux command, what the pane `capture` shows (`styled`: as for
   *  capturePane). One command, so that the list says whose pane it was at the
   *  moment it was read. `screen` is undefined when that pane is not there. */
  async sessionPanes(name: string, capture?: string, styled = false): Promise<{ panes: SessionPane[]; screen?: string }> {
    // Marks tmux's own lines: a start command may hold a line break, and the
    // screen that follows holds whatever a program wrote.
    const mark = `pane:${randomBytes(8).toString('hex')}`;
    const list = ['list-panes', '-s', '-t', `=${name}:`, '-F', `${mark} #{pane_id} #{pane_dead} #{pane_synchronized} #{pane_start_command}`];
    const read = (stdout: string): SessionPane[] => stdout.split('\n').flatMap((line) => {
      const m = line.startsWith(`${mark} `) ? line.slice(mark.length + 1).match(/^(%\d+) ([01]) ([01]) (.*)$/) : null;
      return m ? [{ id: m[1], dead: m[2] === '1', synchronized: m[3] === '1', command: m[4] }] : [];
    });
    if (capture === undefined) return { panes: read((await this.tmux(list)).stdout) };
    let stdout: string;
    try {
      ({ stdout } = await this.tmux([
        ...list, ';', 'display-message', '-p', '-t', `=${name}:`, `${mark} end`,
        ';', 'capture-pane', '-p', ...(styled ? ['-e'] : []), '-t', paneTarget(capture),
      ]));
    } catch (err) {
      // The session is there and that pane is not: say which panes are.
      if (!/can't find pane/i.test(`${(err as { stderr?: string }).stderr ?? ''} ${(err as Error).message ?? ''}`)) throw err;
      return { panes: read((await this.tmux(list)).stdout) };
    }
    const end = `${mark} end\n`;
    const at = stdout.indexOf(end);
    if (at === -1) throw new Error(`tmux did not list the panes of ${name}`);
    return { panes: read(stdout.slice(0, at)), screen: stdout.slice(at + end.length) };
  }

  /** The size of a pane, in cells — of the pane with that id, or of a
   *  session's active pane — and of the window it is in, with the number of
   *  panes there (a window someone split has several, and then the two sizes
   *  differ). */
  async paneSize(target: string): Promise<{ cols: number; rows: number; windowRows: number; panes: number }> {
    // list-panes, not display-message: that one prints an empty line for a
    // session that is not there, this one fails as every other command does.
    // It lists the panes of the window the target is in.
    const { stdout } = await this.tmux(['list-panes', '-t', paneTarget(target), '-F', '#{pane_id} #{pane_active} #{pane_width} #{pane_height} #{window_height} #{window_panes}']);
    const rows = stdout.split('\n').map((line) => line.match(/^(%\d+) ([01]) (\d+) (\d+) (\d+) (\d+)$/));
    const m = rows.find((r) => r && (paneTarget(target) === target ? r[1] === target : r[2] === '1'));
    if (!m) throw new Error(`tmux did not report a pane size for ${target}`);
    return { cols: Number(m[3]), rows: Number(m[4]), windowRows: Number(m[5]), panes: Number(m[6]) };
  }

  /** Give the window that pane is in (or the session's current one) this
   *  many rows (it stays that tall, attached or not: tmux switches the window
   *  to manual sizing). Its width is left as it is — only `-y` is given — so a
   *  window split side by side keeps every pane's width. The programs in it
   *  are told (SIGWINCH) and redraw. */
  async resizeWindowRows(target: string, rows: number): Promise<void> {
    await this.tmux(['resize-window', '-t', paneTarget(target), '-y', String(rows)]);
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

  // `target` here and below: a pane's id, or a session's name for its active
  // pane (paneTarget).
  // `styled`: with the cells' attributes as escape sequences (-e) — one
  // capture then gives both the text and which of it is bold (question.ts).
  async capturePane(target: string, scrollbackLines = 0, styled = false): Promise<string> {
    const args = ['capture-pane', '-p'];
    if (styled) args.push('-e');
    if (scrollbackLines > 0) args.push('-S', `-${scrollbackLines}`);
    args.push('-t', paneTarget(target));
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

  async sendKeys(target: string, ...keys: string[]): Promise<void> {
    await this.tmux(['send-keys', '-t', paneTarget(target), ...keys]);
  }

  /** Literal text (no key-name interpretation — `-l`). */
  async sendText(target: string, text: string): Promise<void> {
    await this.tmux(['send-keys', '-t', paneTarget(target), '-l', '--', text]);
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
