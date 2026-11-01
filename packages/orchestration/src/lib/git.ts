/**
 * Run git in the orchestrator's own process, for the steps that hold a
 * GitHub token: a Lambda invocation that has never run a model is a clean
 * room by construction, so nothing the agent planted can reach these
 * commands.
 *
 * Every command runs with `execFile` (no shell) in a directory from
 * `mkdtemp`, removed afterwards, and with the same hardened environment the
 * session scripts use (HARDENED_GIT_ENV): no system or global configuration,
 * no terminal prompt, no askpass, and HOME inside the temporary directory.
 * Nothing else of the Lambda's environment is passed on, so the function's
 * AWS credentials never reach git.
 *
 * The token is given only to the commands that talk to the remote, as
 * `http.extraHeader` through git's environment configuration
 * (`GIT_CONFIG_COUNT`), so it is in no file, no argument list and no remote
 * URL. A failing command is reported by its subcommand, exit code and stderr,
 * with the token redacted, never by its arguments.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { redactSecrets } from '@factorial/artefacts';

import { gitAuthHeader } from './shell.ts';

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitWorkspace {
  /** The temporary directory, removed when the work is done. */
  dir: string;
  /** The environment every command runs with. */
  env: NodeJS.ProcessEnv;
}

export interface GitOptions {
  /** Directory to run in; the workspace's own directory when absent. */
  cwd?: string;
  /** Written to the command's stdin. */
  input?: string;
  /** Extra environment for this command only, such as a commit identity. */
  env?: NodeJS.ProcessEnv;
  /** An installation token, sent as an authorisation header; only for commands that reach the remote. */
  token?: string;
  timeoutMs?: number;
}

/** Git output can be large (rev-list of a long branch); far beyond anything Collect reads. */
const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000;

/** The environment of every git command: the hardened settings, and nothing of the Lambda's but PATH. */
export function hardenedGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
  };
}

/** The header as git configuration in the environment, so it is in no file and no argument. */
export function authConfigEnv(token: string): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: gitAuthHeader(token),
  };
}

/** Remove every form of the token from text git wrote: the token, its basic credential and the header. */
export function redactToken(text: string, token: string | undefined): string {
  let out = text;
  if (token) {
    const header = gitAuthHeader(token);
    const basic = header.slice(header.lastIndexOf(' ') + 1);
    for (const secret of [header, basic, token]) out = out.split(secret).join('[REDACTED]');
  }
  return redactSecrets(out);
}

/** The subcommand, for messages: the first argument that is not a `-c` setting. */
function subcommand(args: string[]): string {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '-c') i += 1;
    else return args[i] ?? 'git';
  }
  return 'git';
}

/** Run git and return its output whatever its exit code; rejects only when git cannot be run at all. */
export function runGit(workspace: GitWorkspace, args: string[], options: GitOptions = {}): Promise<GitResult> {
  const env = { ...workspace.env, ...options.env, ...(options.token ? authConfigEnv(options.token) : {}) };
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd: options.cwd ?? workspace.dir, env, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          // Not an exit status: git is missing, timed out or overflowed the
          // buffer. The error's own message names the arguments, so it is not used.
          const reason = error.killed ? `was stopped (${error.signal ?? 'timeout'})` : `could not run (${String(error.code ?? 'unknown')})`;
          reject(new Error(`git ${subcommand(args)} ${reason}: ${redactToken(stderr.slice(-2000), options.token)}`));
          return;
        }
        resolve({ stdout, stderr, exitCode: error ? (error.code as number) : 0 });
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input ?? '');
  });
}

/** Run git and throw, with its exit code and redacted stderr, if it exits non-zero. */
export async function mustGit(workspace: GitWorkspace, args: string[], options: GitOptions = {}): Promise<string> {
  const result = await runGit(workspace, args, options);
  if (result.exitCode !== 0) {
    throw new Error(`git ${subcommand(args)} exited ${result.exitCode}: ${redactToken(result.stderr.slice(-2000), options.token)}`);
  }
  return result.stdout;
}

/** Do some git work in a fresh temporary directory, removed however the work ends. */
export async function withGitWorkspace<T>(work: (workspace: GitWorkspace) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'factorial-git-'));
  try {
    const home = path.join(dir, 'home');
    await mkdir(home);
    return await work({ dir, env: hardenedGitEnv(home) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
