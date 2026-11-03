/**
 * CollectVerifier (#167): judge one verifier. The invoker that ran it wrote
 * `verify/<name>/result.json`; this reads it back (the one key of the stage
 * granted for reading) and checks it against the contract, the verifier and
 * the tested commit. When there is no valid result, because PrepareVerify or
 * the task failed or the state timed out, it writes one, with the outcome
 * `timed-out` for a timeout and `error` otherwise: never a pass.
 *
 * A required verifier that did not pass throws VerifierFailed, which fails
 * the Map and so stops the verifiers after it; the turn ends as
 * `tests-failed`, naming it. An optional one is recorded and the list goes
 * on. The verifier's session is stopped here as well as by the invoker, so a
 * task that died early leaves no session idling.
 */
import { getTextArtefact, putJsonArtefact } from '@factorial/artefacts';
import { parseVerifierResult, verifierPath, verifierSessionId, type Verifier, type VerifierResult } from '@factorial/verifiers';

import type { WorkContext } from '../lib/context.ts';
import { runKey, type Logger } from '../lib/log.ts';
import { staged, type ProgressInput, type StagePolicy } from '../lib/progress.ts';
import { sessionTarget, stopSessionQuietly } from '../lib/session.ts';
import { assertCommitSha } from '../lib/shell.ts';
import { VerifierFailedError, verifierDigest, type VerifierDigest } from '../lib/verify.ts';

export interface CollectVerifierInput extends ProgressInput {
  ctx: WorkContext;
  collect: { headSha: string };
  verifier: Verifier;
  index: number;
  /** When PrepareVerify or RunVerifier failed: the state's error output. */
  error?: { Error?: string; Cause?: string } | null;
  /** When the state started, for the duration of a result written here. */
  startedAt?: string | null;
}

/** A result is far smaller than this. */
const MAX_RESULT_BYTES = 64 * 1024;

/** A failing required verifier ends the Verify stage as failed (the throw); a passing one leaves it to PrepareReview. */
export const collectVerifierStage: StagePolicy<CollectVerifierInput, VerifierDigest> = { endsLater: true };

/** The stored result, if there is a valid one for this verifier on this commit. */
export function checkedResult(text: string | undefined, verifier: Verifier, sha: string): { result?: VerifierResult; problem?: string } {
  if (text === undefined) return { problem: 'no result was written' };
  const parsed = parseVerifierResult(text);
  if (!parsed.ok) return { problem: `the stored result is not valid: ${parsed.errors.slice(0, 3).join('; ')}` };
  const result = parsed.value;
  if (result.name !== verifier.name) return { problem: `the stored result is for ${result.name}` };
  if (result.sha !== sha) return { problem: `the stored result is for ${result.sha}, not ${sha}` };
  // As declared on the base branch: the stored copy cannot make a required verifier optional.
  return { result: { ...result, required: verifier.required } };
}

/** The result when the verifier left none: why, from the state's error, never a pass. */
export function missingResult(input: CollectVerifierInput, sha: string, problem: string, now: Date): VerifierResult {
  const timedOut = input.error?.Error === 'States.Timeout';
  const startedAt = input.startedAt && !Number.isNaN(Date.parse(input.startedAt)) ? new Date(input.startedAt) : now;
  const why = input.error?.Error ? `the step failed (${input.error.Error})` : problem;
  return {
    schemaVersion: 1,
    name: input.verifier.name,
    kind: input.verifier.kind,
    required: input.verifier.required,
    sha,
    outcome: timedOut ? 'timed-out' : 'error',
    detail: (timedOut ? 'the stage timed out before the check ended' : why).slice(0, 500),
    startedAt: startedAt.toISOString(),
    finishedAt: now.toISOString(),
    durationSeconds: Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000)),
  };
}

export async function collectVerifier(input: CollectVerifierInput, log: Logger, now: () => Date = () => new Date()): Promise<VerifierDigest> {
  const { ctx, verifier } = input;
  const sha = assertCommitSha(input.collect.headSha, 'tested head');
  const path = verifierPath(verifier.name, 'result.json');
  // A failed step wrote no result, or one from a run that did not finish; only a clean run's counts.
  const stored = input.error ? undefined : await getTextArtefact(ctx.artefactPrefix, path, MAX_RESULT_BYTES);
  const { result: found, problem } = input.error ? { problem: 'the step failed' } : checkedResult(stored?.text, verifier, sha);
  let result = found;
  if (!result) {
    result = missingResult(input, sha, problem ?? 'no result', now());
    log.error('no valid verifier result; recording one', { verifier: verifier.name, problem, error: input.error?.Error });
    await putJsonArtefact(ctx.artefactPrefix, path, result);
  }
  await stopSessionQuietly(sessionTarget(verifierSessionId(ctx.workItem.id, input.index), 'verifier'), log);
  const digest = verifierDigest(result);
  log.info('verifier judged', { ...digest });
  if (digest.required && digest.outcome !== 'passed') throw new VerifierFailedError(digest);
  return digest;
}

export const handler = staged('collect-verifier', (input: CollectVerifierInput) => runKey(input.ctx), collectVerifierStage, (input, log) => collectVerifier(input, log));
