/**
 * CollectVerifier (#167): judge one verifier from its task. RunVerifier's
 * Fargate task exits with the check's status (packages/agent-runtime/src/
 * verifier/runner.ts); a zero exit is the state's result, and any other fails
 * the state with the stopped task in the error's cause, as the builder's
 * incomplete exit does. Either way this reads the verifier container's exit
 * status, writes the end of the task's log stream as `verify/<name>/output.log`
 * and the result as `verify/<name>/result.json`. This Lambda has never run the
 * target's code, so the check cannot write its own result.
 *
 * A task with no exit status (PrepareVerify failed, the task could not start,
 * or the state timed out) is `timed-out` for a timeout and `error` otherwise:
 * never a pass. A required verifier that did not pass throws VerifierFailed,
 * which fails the Map and so stops the verifiers after it; the turn ends as
 * `tests-failed`, naming it. An optional one is recorded and the list goes on.
 * The verifier's bundle is deleted from the transfer bucket here, once the
 * task has finished with it.
 */
import { CloudWatchLogsClient, GetLogEventsCommand, ResourceNotFoundException } from '@aws-sdk/client-cloudwatch-logs';

import { artefactKey, putArtefact, putJsonArtefact } from '@factorial/artefacts';
import { VERIFIER_CONTAINER, outcomeOf, validateVerifierResult, verifierPath, type Verifier, type VerifierResult } from '@factorial/verifiers';

import type { WorkContext } from '../lib/context.ts';
import { requireEnv } from '../lib/env.ts';
import { runKey, type Logger } from '../lib/log.ts';
import { staged, type ProgressInput, type StagePolicy } from '../lib/progress.ts';
import { assertCommitSha } from '../lib/shell.ts';
import { s3Transfer } from '../lib/transfer.ts';
import { VerifierFailedError, verifierDigest, type VerifierDigest } from '../lib/verify.ts';

import { verifierBundleKey } from './prepare-verify.ts';

/** The stopped ECS task, as Step Functions reports it: the state's result, or the cause of its TaskFailed error. */
export interface StoppedTask {
  TaskArn?: string;
  StartedAt?: number | string;
  StoppedAt?: number | string;
  StoppedReason?: string;
  Containers?: Array<{ Name?: string; ExitCode?: number; Reason?: string }>;
}

export interface CollectVerifierInput extends ProgressInput {
  ctx: WorkContext;
  collect: { headSha: string };
  verifier: Verifier;
  index: number;
  /** RunVerifier's result when the task exited 0. */
  task?: StoppedTask | null;
  /** When PrepareVerify or RunVerifier failed: the state's error output. */
  error?: { Error?: string; Cause?: string } | null;
  /** When the iteration started, for a result with no task times. */
  startedAt?: string | null;
}

/** The most of the log kept, from the end: where a failing check says why. */
export const MAX_LOG_BYTES = 256 * 1024;

/** A failing required verifier ends the Verify stage as failed (the throw); a passing one leaves it to PrepareReview. */
export const collectVerifierStage: StagePolicy<CollectVerifierInput, VerifierDigest> = { endsLater: true };

function parse(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The stopped task: the state's result, or, for a non-zero exit, the cause Step Functions put in the TaskFailed error. */
export function stoppedTask(input: Pick<CollectVerifierInput, 'task' | 'error'>): StoppedTask | undefined {
  if (input.task) return input.task;
  if (input.error?.Error !== 'States.TaskFailed') return undefined;
  const cause = parse(input.error.Cause);
  return typeof cause === 'object' && cause !== null && Array.isArray((cause as StoppedTask).Containers) ? (cause as StoppedTask) : undefined;
}

/** A task time as Step Functions gives it: epoch milliseconds, or a date string. */
function timeOf(value: number | string | undefined): Date | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value);
  return undefined;
}

function seconds(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
}

/** The result, without its log: from the verifier container's exit status, or why there is none. */
export function judge(input: CollectVerifierInput, sha: string, now: Date): VerifierResult {
  const { verifier } = input;
  const task = stoppedTask(input);
  const container = task?.Containers?.find((c) => c.Name === VERIFIER_CONTAINER);
  const iterationStart = timeOf(input.startedAt ?? undefined) ?? now;
  const startedAt = timeOf(task?.StartedAt) ?? iterationStart;
  const finishedAt = timeOf(task?.StoppedAt) ?? now;
  const base = { schemaVersion: 1 as const, name: verifier.name, kind: verifier.kind, required: verifier.required, sha, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString() };
  const exitCode = container?.ExitCode;
  if (typeof exitCode === 'number' && Number.isInteger(exitCode)) {
    const durationSeconds = seconds(startedAt, finishedAt);
    let { outcome, detail } = outcomeOf(exitCode, durationSeconds, verifier.timeoutSeconds);
    if (exitCode === 137 && /OutOfMemory/i.test(container?.Reason ?? '')) ({ outcome, detail } = { outcome: 'error', detail: 'the task ran out of memory' });
    return { ...base, outcome, exitCode, ...(detail ? { detail } : {}), durationSeconds };
  }
  const timedOut = input.error?.Error === 'States.Timeout';
  const why = timedOut
    ? 'the stage timed out before the check ended'
    : task?.StoppedReason
      ? `the task stopped without an exit status: ${task.StoppedReason}`
      : input.error?.Error
        ? `the step failed (${input.error.Error})`
        : 'the task left no exit status';
  return { ...base, startedAt: iterationStart.toISOString(), outcome: timedOut ? 'timed-out' : 'error', detail: why.replace(/[\r\n]+/g, ' ').slice(0, 500), durationSeconds: seconds(iterationStart, now) };
}

/** The end of a task's log stream. */
export interface LogTail {
  text: string;
  /** Whether earlier output is left out. */
  truncated: boolean;
}

export interface CollectVerifierDeps {
  readLog(taskArn: string): Promise<LogTail | undefined>;
  putText(prefix: string, path: string, text: string): Promise<void>;
  putJson(prefix: string, path: string, value: unknown): Promise<void>;
  removeBundle(key: string): Promise<void>;
  now(): Date;
}

/** The task's log stream: `<prefix>/<container>/<task id>` under the awslogs driver (VerifierTaskDefinition). */
export function logStreamOf(taskArn: string): string | undefined {
  const id = /^arn:aws[a-z-]*:ecs:[a-z0-9-]+:\d{12}:task\/[A-Za-z0-9_-]+\/([0-9a-f]{32})$/.exec(taskArn)?.[1];
  return id ? `verifier/${VERIFIER_CONTAINER}/${id}` : undefined;
}

/** The last MAX_LOG_BYTES of events, joined as lines; GetLogEvents from the end returns the newest page. */
export function tailOf(messages: string[], fullPage: boolean, max = MAX_LOG_BYTES): LogTail {
  const all = messages.map((m) => (m.endsWith('\n') ? m : `${m}\n`)).join('');
  const bytes = Buffer.from(all, 'utf8');
  if (bytes.length <= max) return { text: all, truncated: fullPage };
  return { text: bytes.subarray(bytes.length - max).toString('utf8').replace(/^�+/, ''), truncated: true };
}

let logsClient: CloudWatchLogsClient | undefined;

/** The page size GetLogEvents returns at most. */
const LOG_PAGE_EVENTS = 10_000;

export const defaultDeps: CollectVerifierDeps = {
  async readLog(taskArn) {
    const stream = logStreamOf(taskArn);
    if (!stream) return undefined;
    try {
      const page = await (logsClient ??= new CloudWatchLogsClient({})).send(
        new GetLogEventsCommand({ logGroupName: requireEnv('VERIFIER_LOG_GROUP'), logStreamName: stream, startFromHead: false, limit: LOG_PAGE_EVENTS }),
      );
      const events = page.events ?? [];
      return tailOf(
        events.map((e) => e.message ?? ''),
        events.length >= LOG_PAGE_EVENTS,
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return undefined;
      throw error;
    }
  },
  putText: (prefix, path, text) => putArtefact(prefix, path, text, 'text/plain; charset=utf-8'),
  putJson: putJsonArtefact,
  removeBundle: (key) => s3Transfer.remove(key),
  now: () => new Date(),
};

export async function collectVerifier(input: CollectVerifierInput, log: Logger, deps: CollectVerifierDeps = defaultDeps): Promise<VerifierDigest> {
  const { ctx, verifier } = input;
  const sha = assertCommitSha(input.collect.headSha, 'tested head');
  let result = judge(input, sha, deps.now());
  const taskArn = stoppedTask(input)?.TaskArn;
  if (taskArn) {
    // The log is evidence, not the verdict: a failed read leaves the result without it.
    const tail = await deps.readLog(taskArn).catch((error: unknown) => {
      log.error('could not read the verifier log', { verifier: verifier.name, taskArn, error });
      return undefined;
    });
    if (tail) {
      const path = verifierPath(verifier.name, 'output.log');
      await deps.putText(ctx.artefactPrefix, path, tail.text);
      result = { ...result, log: { key: artefactKey(ctx.artefactPrefix, path), bytes: Buffer.byteLength(tail.text, 'utf8'), truncated: tail.truncated } };
    }
  }
  const valid = validateVerifierResult(result);
  if (!valid.ok) throw new Error(`the verifier result is not valid: ${valid.errors.join('; ')}`);
  await deps.putJson(ctx.artefactPrefix, verifierPath(verifier.name, 'result.json'), result);
  await deps.removeBundle(verifierBundleKey(ctx, verifier)).catch((error: unknown) => log.error('could not delete the verifier bundle', { verifier: verifier.name, error }));
  const digest = verifierDigest(result);
  log.info('verifier judged', { ...digest, taskArn, exitCode: result.exitCode, detail: result.detail });
  if (digest.required && digest.outcome !== 'passed') throw new VerifierFailedError(digest);
  return digest;
}

export const handler = staged('collect-verifier', (input: CollectVerifierInput) => runKey(input.ctx), collectVerifierStage, (input, log) => collectVerifier(input, log));
