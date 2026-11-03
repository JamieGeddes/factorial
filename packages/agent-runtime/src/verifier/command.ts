/**
 * Runs one declared check in a verifier session (#167), as
 * `node /opt/factorial/agent-runtime/verify.mjs <timeoutSeconds> <run, base64>`.
 * The invoker sends that line through the session command API, which runs it
 * as root; this is root-owned code from the image, so nothing in the
 * repository under test can change what it does.
 *
 * It configures npm's mirror for the agent user as the agent host does for a
 * run (npm.ts: a read-only token in the agent's ~/.npmrc, the registry in the
 * command's environment), then runs the check as the agent user through the
 * host's own drop (setpriv: no new privileges, an empty bounding set), in the
 * repository's root, with the agent shell's allow-listed environment: no AWS
 * credentials and nothing else of root's. `timeout` stops it at its limit
 * (exit 124, or 137 once it has had to kill it). Output goes to stdout as it
 * arrives, for the invoker to keep. The exit status is the check's.
 *
 * A failure before the check starts exits SETUP_FAILED, which the invoker
 * records as `error`: never a pass.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { readNpmMirror, type Config } from '../config.ts';
import { configureNpm } from '../npm.ts';
import { shellEnvironment } from '../pi/environment.ts';
import { SETPRIV, runAsAgent, type AgentRunner } from '../pi/as-agent.ts';

import { BUSY_MARKER } from './host.ts';

/** The exit status for a check that could not be started; `timeout` uses 125 for the same. */
export const SETUP_FAILED = 125;

/** How long `timeout` waits after its TERM before it kills the check. */
export const KILL_AFTER_SECONDS = 30;

export interface CheckRequest {
  timeoutSeconds: number;
  run: string;
}

/** The arguments as the invoker sends them: the timeout, and the command in base64 so no quoting can break the line. */
export function parseArguments(argv: readonly string[]): CheckRequest {
  const [timeout, encoded] = argv;
  const timeoutSeconds = Number(timeout);
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw new Error('the timeout is not a whole number of seconds up to 3600');
  if (!encoded || !/^[A-Za-z0-9+/]+=*$/.test(encoded)) throw new Error('the command is not base64');
  const run = Buffer.from(encoded, 'base64').toString('utf8');
  if (run.trim().length === 0 || run.includes('\0')) throw new Error('the command is empty or holds a NUL');
  return { timeoutSeconds, run };
}

/** The check's argv after the drop: bash in the repository, under `timeout`. */
export function checkArgv(request: CheckRequest): string[] {
  return ['timeout', `--kill-after=${KILL_AFTER_SECONDS}`, String(request.timeoutSeconds), 'bash', '-c', request.run];
}

export interface CheckDeps {
  env: NodeJS.ProcessEnv;
  /** npm's mirror for the agent user; npm.ts's when absent. */
  configureNpm?: typeof configureNpm;
  run?: typeof runAsAgent;
  write?: (data: Buffer | string) => void;
  /** The marker /ping reads; written and removed around the check. */
  busy?: { set(): void; clear(): void };
  prefix?: readonly string[];
  repository?: string;
  agentHome?: string;
}

const markBusy = {
  set: () => {
    mkdirSync('/var/lib/factorial', { recursive: true, mode: 0o700 });
    writeFileSync(BUSY_MARKER, String(Date.now()));
  },
  clear: () => rmSync(BUSY_MARKER, { force: true }),
};

/**
 * Run the check and return its exit status. The mirror is required: npm must
 * not fall back to the public registry (CLAUDE.md, Agent environment), and a
 * Runtime version that names none is a deployment fault, reported as such.
 */
export async function runCheck(request: CheckRequest, deps: CheckDeps): Promise<number> {
  const write = deps.write ?? ((data) => process.stdout.write(data));
  const region = deps.env.AWS_REGION;
  const agentHome = deps.agentHome ?? '/home/agent';
  let config: Pick<Config, 'npmMirror' | 'region' | 'agentHome' | 'maxDurationSeconds'>;
  try {
    if (!region) throw new Error('AWS_REGION is not set');
    const npmMirror = readNpmMirror(deps.env, region);
    if (!npmMirror) throw new Error('the verifier Runtime version names no npm mirror (FACTORIAL_CODEARTIFACT_*)');
    config = { npmMirror, region, agentHome, maxDurationSeconds: request.timeoutSeconds + KILL_AFTER_SECONDS };
    await (deps.configureNpm ?? configureNpm)(config);
  } catch (error) {
    write(`factorial: the check was not started: ${error instanceof Error ? error.message : String(error)}\n`);
    return SETUP_FAILED;
  }
  const runner: AgentRunner = { prefix: deps.prefix ?? SETPRIV, env: shellEnvironment(config, deps.env) };
  const busy = deps.busy ?? markBusy;
  busy.set();
  try {
    const result = await (deps.run ?? runAsAgent)(runner, checkArgv(request), { cwd: deps.repository ?? '/workspace/repo', onData: (data) => write(data) });
    return result.exitCode ?? SETUP_FAILED;
  } finally {
    busy.clear();
  }
}

/** The entry point the image runs (agent-runtime/Dockerfile copies it as verify.mjs). */
export async function main(argv: readonly string[]): Promise<number> {
  if (process.getuid?.() !== 0) {
    process.stdout.write('factorial: the check runner must start as root, to drop to the agent user\n');
    return SETUP_FAILED;
  }
  let request: CheckRequest;
  try {
    request = parseArguments(argv);
  } catch (error) {
    process.stdout.write(`factorial: ${error instanceof Error ? error.message : String(error)}\n`);
    return SETUP_FAILED;
  }
  return runCheck(request, { env: process.env });
}
