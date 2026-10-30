/**
 * Runs a command as the agent user. pi runs its loop and tools in the host
 * process, which is root, so every tool that touches the workspace or runs a
 * command goes through here: the model's shell, and the file operations
 * (agent-ops.ts), so root never follows a link the model planted. The image's
 * `rg` wrapper (agent-runtime/rg-as-agent) drops the same way: no_new_privs
 * and an empty bounding set stop anything the agent runs from regaining
 * privilege.
 */
import { spawn } from 'node:child_process';

/** What runs a command as the agent user: setpriv on the Runtime; empty in tests, which run as the current user. */
export const SETPRIV = ['setpriv', '--reuid=agent', '--regid=agent', '--init-groups', '--no-new-privs', '--bounding-set=-all', '--'];

export interface AgentRunner {
  /** The prefix that drops to the agent user. */
  prefix: readonly string[];
  /** The environment the command gets, in place of the host's. */
  env: Readonly<Record<string, string>>;
}

export interface RunOptions {
  cwd: string;
  input?: string | Buffer;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  /** Receives stdout and stderr as they arrive; otherwise both are collected. */
  onData?: (data: Buffer) => void;
}

export interface RunResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
}

export function runAsAgent(runner: AgentRunner, argv: readonly string[], options: RunOptions): Promise<RunResult> {
  const [command, ...args] = [...runner.prefix, ...argv];
  return new Promise((resolve, reject) => {
    const child = spawn(command!, args, {
      cwd: options.cwd,
      env: { ...runner.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
      ...(options.timeoutMs ? { timeout: options.timeoutMs, killSignal: 'SIGKILL' as const } : {}),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (data: Buffer) => (options.onData ? options.onData(data) : stdout.push(data)));
    child.stderr.on('data', (data: Buffer) => (options.onData ? options.onData(data) : stderr.push(data)));
    child.on('error', (error) => (error.name === 'AbortError' ? resolve({ exitCode: null, stdout: Buffer.concat(stdout), stderr: 'aborted' }) : reject(error)));
    child.on('close', (code, signal) =>
      resolve({ exitCode: code ?? (signal ? 128 + signalNumber(signal) : null), stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') }),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(options.input ?? '');
  });
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
const signalNumber = (signal: string): number => SIGNALS[signal] ?? 0;
