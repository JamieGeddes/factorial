/**
 * The verifier task's entrypoint (#167): run one declared check at the tested
 * commit as the agent user, and exit with its status.
 *
 * Each verifier a target declares runs in a fresh Fargate task from this
 * image (VerifierTaskDefinition in templates/orchestration.yml), started by
 * the state machine with the verifier, the tested commit and a presigned URL
 * to a bundle of the work branch that PrepareVerify fetched. No token is in
 * the task and nothing in it reaches GitHub. This runner is root, root-owned
 * code from the image, so nothing in the repository under test can change
 * what it does. It:
 *
 * 1. downloads the bundle into a directory only root can read, sets the
 *    repository up from it on the work branch, and fails unless the head is
 *    the tested commit;
 * 2. gives /workspace to the agent user;
 * 3. configures npm's mirror for that user with the task role, as the agent
 *    host does for a run (npm.ts: a read-only token in the agent's ~/.npmrc,
 *    the registry in the command's environment);
 * 4. runs the check as the agent user through the host's own drop (setpriv:
 *    no new privileges, an empty bounding set), in the repository's root,
 *    with the agent shell's allow-listed environment, so none of the task's
 *    credentials or its credentials endpoint, under `timeout` (exit 124, or
 *    137 once it has had to kill it);
 * 5. writes the check's output to stdout, redacted line by line, for the
 *    task's log stream, where CollectVerifier reads the end of it;
 * 6. exits with the check's status, which CollectVerifier reads from the task.
 *
 * Anything that fails before the check starts exits SETUP_FAILED, which
 * CollectVerifier records as `error`: never a pass.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { redactSecrets } from '@factorial/artefacts/redact';
import { createLogger, type Logger } from '@factorial/log';
import { KILL_AFTER_SECONDS, SETUP_FAILED } from '@factorial/verifiers/exit';

import { readNpmMirror, type Config } from '../config.ts';
import { configureNpm } from '../npm.ts';
import { shellEnvironment } from '../pi/environment.ts';
import { SETPRIV, runAsAgent, type AgentRunner } from '../pi/as-agent.ts';

/** The longest check the contract allows (contracts/verifiers/v1/verifiers.schema.json). */
export const MAX_TIMEOUT_SECONDS = 7200;

const WORKSPACE = '/workspace';
const AGENT_HOME = '/home/agent';

export interface Check {
  name: string;
  run: string;
  timeoutSeconds: number;
}

export interface VerifyTask {
  workItemId: string;
  check: Check;
  /** The commit every verifier runs on: the head Collect pushed. */
  sha: string;
  /** The work branch the bundle carries at `sha`. */
  branch: string;
  /** The repository's default branch, `origin/HEAD` in the checkout. */
  defaultBranch: string;
  repository: { owner: string; name: string };
  bundleUrl: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** A branch name git will take as a name, never as an option. The value reaches git only as an argument, never through a shell. */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/;
const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

function branchOf(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!BRANCH.test(value) || value.endsWith('.lock')) throw new Error(`${name} is not a branch name`);
  return value;
}

/** The declared verifier as the state passes it: checked again here, since this acts on it. */
function checkOf(text: string): Check {
  const value = JSON.parse(text) as Partial<Check> & { kind?: unknown };
  const { name, run, timeoutSeconds, kind } = value;
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw new Error('VERIFIER has no valid name');
  if (kind !== 'command') throw new Error(`VERIFIER kind ${String(kind)} is not one this runner runs`);
  if (typeof run !== 'string' || run.trim().length === 0 || run.length > 2000 || run.includes('\0')) throw new Error('VERIFIER has no valid command');
  if (typeof timeoutSeconds !== 'number' || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    throw new Error('VERIFIER timeout is out of range');
  }
  return { name, run, timeoutSeconds };
}

/** Read and check the task's input, from the state machine's container overrides. */
export function verifyTask(env: NodeJS.ProcessEnv): VerifyTask {
  const workItemId = required(env, 'WORK_ITEM_ID');
  if (!/^[0-9a-f-]{36}$/.test(workItemId)) throw new Error('WORK_ITEM_ID is not a UUID');
  const sha = required(env, 'VERIFY_SHA');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('VERIFY_SHA is not a commit sha');
  const [owner, name, ...rest] = required(env, 'REPOSITORY').split('/');
  if (!owner || !name || rest.length > 0 || !GITHUB_NAME.test(owner) || !GITHUB_NAME.test(name)) throw new Error('REPOSITORY is not <owner>/<name>');
  const bundleUrl = required(env, 'BUNDLE_URL');
  if (!/^https:\/\/[^\s'"\\]+$/.test(bundleUrl)) throw new Error('BUNDLE_URL is not a plain https URL');
  return {
    workItemId,
    check: checkOf(required(env, 'VERIFIER')),
    sha,
    branch: branchOf(env, 'VERIFY_BRANCH'),
    defaultBranch: branchOf(env, 'DEFAULT_BRANCH'),
    repository: { owner, name },
    bundleUrl,
  };
}

/** git with no system or global configuration and no prompt: the repository's own config is the only one, and it is ours. */
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' };

export type Exec = (command: string, args: readonly string[], options: { cwd?: string; timeoutMs?: number }) => Promise<string>;

const execFileAsync = promisify(execFile);

/** Run a program without a shell, failing with its stderr, never its arguments (the bundle URL is one). */
export const exec: Exec = async (command, args, options) => {
  try {
    const { stdout } = await execFileAsync(command, [...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME ?? '/root', ...GIT_ENV },
      timeout: options.timeoutMs ?? 600_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const why = typeof stderr === 'string' && stderr.trim() ? stderr.trim().split('\n').slice(-3).join(' ') : (error as { code?: unknown }).code;
    throw new Error(`${command}${command === 'git' ? ` ${args[0] ?? ''}` : ''} failed: ${String(why ?? 'unknown error')}`.replace(/\s+/g, ' '));
  }
};

export interface SeedOptions {
  exec?: Exec;
  /** Where the repository goes: /workspace/repo. */
  workspace?: string;
  /** Where the bundle is downloaded: a directory under it only root can read. */
  tmp?: string;
  /** curl's protocols: https in the task; tests use file. */
  protocols?: string;
  /** Give the workspace to the agent user; off in tests, which run as the current user. */
  handOver?: boolean;
}

/**
 * Set the repository up from the bundle, as the session seed script did
 * (packages/orchestration/src/lib/repo-seed.ts): `origin` is the GitHub URL,
 * so `origin/<default>` and three-dot diffs keep their names, but it is never
 * contacted. The bundle is removed however this ends.
 */
export async function seed(task: Pick<VerifyTask, 'sha' | 'branch' | 'defaultBranch' | 'repository' | 'bundleUrl'>, options: SeedOptions = {}): Promise<void> {
  const run = options.exec ?? exec;
  const workspace = options.workspace ?? WORKSPACE;
  const repo = path.join(workspace, 'repo');
  // mkdtemp makes the directory 0700.
  const dir = mkdtempSync(path.join(options.tmp ?? '/tmp', 'factorial-seed-'));
  const bundle = path.join(dir, 'repo.bundle');
  try {
    await run('curl', ['-fsS', '--retry', '3', '--max-time', '600', '--proto', options.protocols ?? '=https', '-o', bundle, task.bundleUrl], {});
    rmSync(repo, { recursive: true, force: true });
    await run('git', ['init', '--quiet', repo], {});
    const git = (...args: string[]): Promise<string> => run('git', args, { cwd: repo });
    await git('remote', 'add', 'origin', `https://github.com/${task.repository.owner}/${task.repository.name}.git`);
    await git('bundle', 'verify', '--quiet', bundle);
    // No FETCH_HEAD, so the bundle's path is written nowhere in the repository.
    await git('fetch', '--quiet', '--no-tags', '--no-write-fetch-head', bundle, '+refs/heads/*:refs/remotes/origin/*');
    await git('symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${task.defaultBranch}`);
    await git('checkout', '--quiet', '--no-track', '-b', task.branch, `refs/remotes/origin/${task.branch}`);
    const head = (await git('rev-parse', 'HEAD')).trim();
    if (head !== task.sha) throw new Error(`branch ${task.branch} is at ${head}, not the tested commit ${task.sha}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (options.handOver ?? true) await run('chown', ['-R', 'agent:agent', workspace], {});
}

/** The check's argv after the drop: bash in the repository, under `timeout`. */
export function checkArgv(check: Pick<Check, 'run' | 'timeoutSeconds'>): string[] {
  return ['timeout', `--kill-after=${KILL_AFTER_SECONDS}`, String(check.timeoutSeconds), 'bash', '-c', check.run];
}

/** The most output written to the log in order; past it, only the end is. */
export const MAX_FORWARDED_BYTES = 16 * 1024 * 1024;
/** How much of the end is kept once the cap is reached: what CollectVerifier stores. */
export const TAIL_BYTES = 256 * 1024;
/** A line longer than this is written in pieces rather than held. */
const MAX_LINE_BYTES = 64 * 1024;

/**
 * Passes the check's output on line by line, each line redacted (a token
 * split across two writes is whole again once lines are joined). Up to
 * MAX_FORWARDED_BYTES are written as they arrive; after that only the last
 * TAIL_BYTES are kept and written at the end, so a check that floods its
 * output still leaves where it failed in the log.
 */
export class OutputForwarder {
  readonly #write: (text: string) => void;
  readonly #max: number;
  readonly #tailBytes: number;
  #partial = '';
  #forwarded = 0;
  #tail: string[] = [];
  #tailSize = 0;
  #dropped = 0;
  bytes = 0;

  constructor(write: (text: string) => void, max = MAX_FORWARDED_BYTES, tailBytes = TAIL_BYTES) {
    this.#write = write;
    this.#max = max;
    this.#tailBytes = tailBytes;
  }

  add(data: Buffer | string): void {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    this.bytes += Buffer.byteLength(text, 'utf8');
    const lines = (this.#partial + text).split('\n');
    this.#partial = lines.pop() ?? '';
    for (const line of lines) this.#line(`${line}\n`);
    while (Buffer.byteLength(this.#partial, 'utf8') > MAX_LINE_BYTES) {
      this.#line(this.#partial.slice(0, MAX_LINE_BYTES));
      this.#partial = this.#partial.slice(MAX_LINE_BYTES);
    }
  }

  #line(raw: string): void {
    const line = redactSecrets(raw);
    const size = Buffer.byteLength(line, 'utf8');
    if (this.#forwarded + size <= this.#max && this.#dropped === 0) {
      this.#forwarded += size;
      this.#write(line);
      return;
    }
    this.#tail.push(line);
    this.#tailSize += size;
    this.#dropped += size;
    while (this.#tailSize - (Buffer.byteLength(this.#tail[0] ?? '', 'utf8')) >= this.#tailBytes) this.#tailSize -= Buffer.byteLength(this.#tail.shift()!, 'utf8');
  }

  /** Write what is left: the last line without a newline, then the kept end, if the cap was reached. */
  end(): void {
    if (this.#partial) this.#line(`${this.#partial}\n`);
    this.#partial = '';
    if (this.#dropped === 0) return;
    const skipped = this.#dropped - this.#tailSize;
    if (skipped > 0) this.#write(`[factorial: ${skipped} bytes of output are not in the log; its last ${this.#tailSize} bytes follow]\n`);
    for (const line of this.#tail) this.#write(line);
    this.#tail = [];
  }
}

export interface CheckDeps {
  env: NodeJS.ProcessEnv;
  /** npm's mirror for the agent user; npm.ts's when absent. */
  configureNpm?: typeof configureNpm;
  run?: typeof runAsAgent;
  write?: (data: string) => void;
  prefix?: readonly string[];
  repository?: string;
  agentHome?: string;
}

/**
 * Run the check and return its exit status. The mirror is required: npm must
 * not fall back to the public registry (CLAUDE.md, Agent environment), and a
 * task definition that names none is a deployment fault, reported as such.
 */
export async function runCheck(check: Pick<Check, 'run' | 'timeoutSeconds'>, deps: CheckDeps): Promise<number> {
  const write = deps.write ?? ((data) => process.stdout.write(data));
  const region = deps.env.AWS_REGION;
  const agentHome = deps.agentHome ?? AGENT_HOME;
  let config: Pick<Config, 'npmMirror' | 'region' | 'agentHome' | 'maxDurationSeconds'>;
  try {
    if (!region) throw new Error('AWS_REGION is not set');
    const npmMirror = readNpmMirror(deps.env, region);
    if (!npmMirror) throw new Error('the task definition names no npm mirror (FACTORIAL_CODEARTIFACT_*)');
    config = { npmMirror, region, agentHome, maxDurationSeconds: check.timeoutSeconds + KILL_AFTER_SECONDS };
    await (deps.configureNpm ?? configureNpm)(config);
  } catch (error) {
    write(`factorial: the check was not started: ${error instanceof Error ? error.message : String(error)}\n`);
    return SETUP_FAILED;
  }
  const runner: AgentRunner = { prefix: deps.prefix ?? SETPRIV, env: shellEnvironment(config, deps.env) };
  const output = new OutputForwarder(write);
  try {
    const result = await (deps.run ?? runAsAgent)(runner, checkArgv(check), { cwd: deps.repository ?? path.join(WORKSPACE, 'repo'), onData: (data) => output.add(data) });
    return result.exitCode ?? SETUP_FAILED;
  } finally {
    output.end();
  }
}

/** Root, and reading no configuration from a directory the agent user can write: the agent host's own rule. */
function checkHost(): void {
  if (process.getuid?.() !== 0) throw new Error('the check runner must start as root, to drop to the agent user');
  for (const [name, value] of [['HOME', process.env.HOME], ['cwd', process.cwd()]]) {
    if (!value || value.startsWith(WORKSPACE) || value.startsWith(AGENT_HOME)) {
      throw new Error(`the runner's ${name} (${value}) must be root-owned, outside ${WORKSPACE} and ${AGENT_HOME}`);
    }
  }
}

/** The entry point the task runs (agent-runtime/Dockerfile copies it as verify.mjs). */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let log: Logger = createLogger('verifier');
  let task: VerifyTask;
  try {
    checkHost();
    task = verifyTask(env);
  } catch (error) {
    log.error('the check was not started', { error: error instanceof Error ? error.message : String(error) });
    return SETUP_FAILED;
  }
  log = log.with({ workItemId: task.workItemId });
  log.info('seeding the repository', { verifier: task.check.name, sha: task.sha, branch: task.branch });
  try {
    await seed(task);
  } catch (error) {
    log.error('the repository could not be set up; the check was not started', { verifier: task.check.name, error: error instanceof Error ? error.message : String(error) });
    return SETUP_FAILED;
  }
  log.info('running the check', { verifier: task.check.name, timeoutSeconds: task.check.timeoutSeconds });
  const exitCode = await runCheck(task.check, { env });
  log.info('the check ended', { verifier: task.check.name, exitCode });
  return exitCode;
}
