/**
 * The parts of the invoker's verify mode (verify.ts, #167) that decide
 * anything: which session it may command, the line it sends, how much output
 * it keeps, and how an exit status becomes an outcome.
 */
import type { Verifier, VerifierOutcome, VerifierResult } from '@factorial/verifiers';

/** Where the check runner is in the agent image (agent-runtime/Dockerfile). */
export const CHECK_RUNNER = '/opt/factorial/agent-runtime/verify.mjs';

/** The check runner's status for a check it could not start (packages/agent-runtime/src/verifier/command.ts). */
export const SETUP_FAILED = 125;

/** How long past the check's own timeout the session command may run: the runner's set-up, and `timeout`'s grace period. */
export const COMMAND_MARGIN_SECONDS = 120;

/** A session command runs for at most an hour. */
export const MAX_COMMAND_SECONDS = 3600;

/** The most output kept, from the end: where a failing check says why. */
export const MAX_LOG_BYTES = 256 * 1024;

export interface VerifierTarget {
  runtimeArn: string;
  qualifier: string;
  sessionId: string;
}

export interface VerifyTask {
  target: VerifierTarget;
  workItemId: string;
  artefactPrefix: string;
  sha: string;
  verifier: Verifier;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/** The declared verifier as the state passes it: checked again here, since the task acts on it. */
function verifierOf(text: string): Verifier {
  const value = JSON.parse(text) as Partial<Verifier>;
  const { name, kind, run, required: isRequired, timeoutSeconds } = value;
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw new Error('VERIFIER has no valid name');
  if (kind !== 'command') throw new Error(`VERIFIER kind ${String(kind)} is not one this invoker runs`);
  if (typeof run !== 'string' || run.trim().length === 0 || run.length > 2000 || run.includes('\0')) throw new Error('VERIFIER has no valid command');
  if (typeof isRequired !== 'boolean') throw new Error('VERIFIER does not say whether it is required');
  if (typeof timeoutSeconds !== 'number' || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds + COMMAND_MARGIN_SECONDS > MAX_COMMAND_SECONDS) {
    throw new Error('VERIFIER timeout is out of range');
  }
  return { name, kind, run, required: isRequired, timeoutSeconds };
}

/**
 * Read and check the task's input. The Runtime must be the verifier's,
 * `factorial_verifier-…`: a check is never run in a role's session.
 */
export function verifyTask(env: Record<string, string | undefined>): VerifyTask {
  const runtimeArn = required(env, 'RUNTIME_ARN');
  if (!/^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:[0-9]{12}:runtime\/factorial_verifier-[A-Za-z0-9]+$/.test(runtimeArn)) {
    throw new Error('RUNTIME_ARN does not name the verifier runtime');
  }
  const qualifier = required(env, 'RUNTIME_QUALIFIER');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(qualifier)) throw new Error(`"${qualifier}" is not an endpoint name`);
  const workItemId = required(env, 'WORK_ITEM_ID');
  if (!/^[0-9a-f-]{36}$/.test(workItemId)) throw new Error('WORK_ITEM_ID is not a UUID');
  const sessionId = required(env, 'SESSION_ID');
  if (!sessionId.startsWith(`${workItemId}-verify-`)) throw new Error("SESSION_ID is not one of the work item's verifier sessions");
  const artefactPrefix = required(env, 'ARTEFACT_PREFIX');
  if (!artefactPrefix.startsWith(`${workItemId}/`)) throw new Error("ARTEFACT_PREFIX is not the work item's");
  const sha = required(env, 'VERIFY_SHA');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('VERIFY_SHA is not a commit sha');
  return { target: { runtimeArn, qualifier, sessionId }, workItemId, artefactPrefix, sha, verifier: verifierOf(required(env, 'VERIFIER')) };
}

/**
 * The session command: the image's check runner with the timeout and the
 * command in base64. The command API splits the line into words and runs the
 * first, so the line holds no shell syntax at all.
 */
export function checkCommand(verifier: Pick<Verifier, 'run' | 'timeoutSeconds'>): string {
  return `node ${CHECK_RUNNER} ${verifier.timeoutSeconds} ${Buffer.from(verifier.run, 'utf8').toString('base64')}`;
}

/** The command API's own limit for the session command. */
export const commandTimeoutSeconds = (verifier: Pick<Verifier, 'timeoutSeconds'>): number =>
  Math.min(MAX_COMMAND_SECONDS, verifier.timeoutSeconds + COMMAND_MARGIN_SECONDS);

/** The end of a stream of output, at most `max` bytes, and how much there was in all. */
export class OutputTail {
  readonly #max: number;
  #chunks: Buffer[] = [];
  #kept = 0;
  bytes = 0;

  constructor(max = MAX_LOG_BYTES) {
    this.#max = max;
  }

  add(data: string | Buffer): void {
    const chunk = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    this.bytes += chunk.length;
    this.#chunks.push(chunk);
    this.#kept += chunk.length;
    while (this.#kept - (this.#chunks[0]?.length ?? 0) >= this.#max) this.#kept -= this.#chunks.shift()!.length;
  }

  get truncated(): boolean {
    return this.bytes > this.#max;
  }

  /** The kept output as text, cut to whole characters at the start. */
  text(): string {
    const all = Buffer.concat(this.#chunks);
    const tail = all.length > this.#max ? all.subarray(all.length - this.#max) : all;
    const text = tail.toString('utf8').replace(/^�+/, '');
    return this.truncated ? `[the first ${this.bytes - tail.length} bytes of output are not kept]\n${text}` : text;
  }
}

/**
 * How an exit status reads. 124 is `timeout` stopping the check, 137 its kill
 * after the grace period once the limit has passed; 125 to 127 are a check
 * that could not be started or found, so `error`, never a pass.
 */
export function outcomeOf(exitCode: number, elapsedSeconds: number, timeoutSeconds: number): { outcome: VerifierOutcome; detail?: string } {
  if (exitCode === 0) return { outcome: 'passed' };
  if (exitCode === 124 || (exitCode === 137 && elapsedSeconds >= timeoutSeconds)) return { outcome: 'timed-out', detail: `stopped after ${timeoutSeconds} seconds` };
  if (exitCode === SETUP_FAILED) return { outcome: 'error', detail: 'the check could not be started (see the log)' };
  if (exitCode === 126 || exitCode === 127) return { outcome: 'error', detail: `the command could not be run (exit ${exitCode}: not executable or not found)` };
  if (exitCode < 0) return { outcome: 'error', detail: 'the session command ended without an exit status' };
  return { outcome: 'failed' };
}

/** `verify/<name>/result.json`. */
export function verifierResult(params: {
  task: VerifyTask;
  outcome: VerifierOutcome;
  exitCode?: number;
  detail?: string;
  startedAt: Date;
  finishedAt: Date;
  log?: VerifierResult['log'];
}): VerifierResult {
  const { task, outcome, exitCode, detail, startedAt, finishedAt, log } = params;
  return {
    schemaVersion: 1,
    name: task.verifier.name,
    kind: task.verifier.kind,
    required: task.verifier.required,
    sha: task.sha,
    outcome,
    ...(exitCode !== undefined && exitCode >= 0 ? { exitCode } : {}),
    ...(detail ? { detail: detail.replace(/[\r\n]+/g, ' ').slice(0, 500) } : {}),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationSeconds: Math.max(0, Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)),
    ...(log ? { log } : {}),
  };
}
