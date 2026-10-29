/**
 * AgentHost — every action that touches the hands' side of the machine (tmux,
 * their files, their transcripts) goes through here, so the split between the
 * spawner's OS user and the agents' OS user lives in one place.
 *
 *  - LocalHost: hands run as the spawner's own user (dev machine).
 *  - SudoHost:  hands run as `agentsUser`; the spawner reaches them with
 *    `sudo -n -H -u <user> -- …` (sudoers: `cc-spawner ALL=(cc-agents) NOPASSWD: ALL`).
 *    One-way by construction: the agents user gets no rule back.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, fstatSync, readSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export interface AgentHost {
  /** Run a command as the agents user. Rejects on non-zero exit. */
  exec(cmd: string, args: string[], opts?: { input?: string }): Promise<{ stdout: string }>;
  /** Write a file as the agents user (parent dirs created 0700). */
  writeFile(path: string, content: string, mode?: number): Promise<void>;
  mkdirp(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Size in bytes, or undefined when the file does not exist. */
  size(path: string): Promise<number | undefined>;
  /** Bytes from `offset` to EOF (empty when nothing new). */
  readFrom(path: string, offset: number): Promise<Buffer>;
}

export class LocalHost implements AgentHost {
  async exec(cmd: string, args: string[], opts: { input?: string } = {}): Promise<{ stdout: string }> {
    if (opts.input === undefined) {
      const { stdout } = await run(cmd, args, { maxBuffer: MAX_BUFFER });
      return { stdout };
    }
    return execWithInput(cmd, args, opts.input);
  }

  async writeFile(path: string, content: string, mode = 0o600): Promise<void> {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { mode });
    chmodSync(path, mode); // writeFileSync's mode only applies on create
  }

  async mkdirp(path: string): Promise<void> {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(path);
  }

  async size(path: string): Promise<number | undefined> {
    try {
      return statSync(path).size;
    } catch {
      return undefined;
    }
  }

  async readFrom(path: string, offset: number): Promise<Buffer> {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size <= offset) return Buffer.alloc(0);
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      return buf;
    } finally {
      closeSync(fd);
    }
  }
}

export class SudoHost implements AgentHost {
  constructor(private readonly user: string) {}

  private argv(cmd: string, args: string[]): string[] {
    return ['-n', '-H', '-u', this.user, '--', cmd, ...args];
  }

  async exec(cmd: string, args: string[], opts: { input?: string } = {}): Promise<{ stdout: string }> {
    if (opts.input === undefined) {
      const { stdout } = await run('sudo', this.argv(cmd, args), { maxBuffer: MAX_BUFFER });
      return { stdout };
    }
    return execWithInput('sudo', this.argv(cmd, args), opts.input);
  }

  async writeFile(path: string, content: string, mode = 0o600): Promise<void> {
    // Content goes over stdin, never argv (argv is world-readable in ps).
    await this.exec(
      'sh',
      ['-c', 'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1" && chmod "$2" "$1"', 'sh', path, mode.toString(8)],
      { input: content },
    );
  }

  async mkdirp(path: string): Promise<void> {
    await this.exec('mkdir', ['-p', '-m', '700', path]);
  }

  // Absence is reported by the shell itself (an answer on stdout); any failure
  // to run — sudo refusing, a permission error — throws instead of reading as
  // "missing", which would e.g. start a fresh conversation instead of a revival.
  async exists(path: string): Promise<boolean> {
    const { stdout } = await this.exec('sh', ['-c', 'if [ -e "$1" ]; then echo yes; else echo no; fi', 'sh', path]);
    return stdout.trim() === 'yes';
  }

  async size(path: string): Promise<number | undefined> {
    // GNU stat (the Linux box), BSD stat as a fallback.
    const { stdout } = await this.exec('sh', [
      '-c',
      'if [ -e "$1" ]; then stat -c %s "$1" 2>/dev/null || stat -f %z "$1"; else echo missing; fi',
      'sh',
      path,
    ]);
    const out = stdout.trim();
    if (out === 'missing') return undefined;
    const n = Number(out);
    if (!out || !Number.isFinite(n)) throw new Error(`could not read the size of ${path}: ${JSON.stringify(out)}`);
    return n;
  }

  async readFrom(path: string, offset: number): Promise<Buffer> {
    const { stdout } = await run('sudo', this.argv('tail', ['-c', `+${offset + 1}`, path]), {
      maxBuffer: MAX_BUFFER,
      encoding: 'buffer',
    });
    return stdout as unknown as Buffer;
  }
}

function execWithInput(cmd: string, args: string[], input: string): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr }));
      else resolve({ stdout });
    });
    child.stdin?.end(input);
  });
}

export function makeHost(agentsUser: string | undefined): AgentHost {
  return agentsUser ? new SudoHost(agentsUser) : new LocalHost();
}
