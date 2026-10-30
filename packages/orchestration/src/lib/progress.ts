/**
 * The progress record for the orchestrator Lambdas (#15). `staged` wraps a
 * handler as `logged` does and records its stage's start and end through
 * `@factorial/progress`, so no Lambda can do one without the other. The state
 * machine passes `progress: { stage, round }` in every task's payload: the
 * state's own name, and the build round. An input without it (an execution
 * started before #15) records nothing.
 *
 * Most stages start when the handler is called and end when it returns or
 * throws. A policy covers the rest: a stage whose result arrives in a later
 * state (Test), stages whose end only a later state knows (a Build task
 * that never ran its invoker), and the states that end the work item.
 */
import { isStageName, progressRecorder, stageError, type ProgressRecorder, type StageError, type StageOutcome } from '@factorial/progress';

import type { StepFailure } from './incomplete.ts';
import { logged, type Logger, type RunKey } from './log.ts';

export { stageError } from '@factorial/progress';

export interface ProgressInput {
  progress?: { stage?: unknown; round?: unknown } | null;
}

/** A stage this one ends, because only this state knows how it went. */
export interface Closing {
  stage: string;
  outcome: StageOutcome;
  error?: StageError;
}

export interface StagePolicy<I, O> {
  /** The handler calls `start` itself: Intake, once the item's ledger row exists. */
  startsInHandler?: boolean;
  /** The stage ends in a later state, not when the handler returns (Test: the workflow reports back). Still ends here on a failure. */
  endsLater?: boolean;
  /** Stages ended when this one starts, recorded only if they have not ended already. */
  closes?: (input: I) => Closing[];
  /** Whether the work item ends with this stage; `result` is undefined when the handler failed. */
  ends?: (input: I, result: O | undefined) => boolean;
  /** The error any stage still open is ended with when the work item ends. */
  failure?: (input: I) => StageError | undefined;
}

/** The stage and round the state machine named, if it named a valid one. */
export function stageOf(input: ProgressInput | null | undefined): { stage: string; round?: number } | undefined {
  const progress = input?.progress;
  if (!progress || !isStageName(progress.stage)) return undefined;
  const round = typeof progress.round === 'number' && Number.isInteger(progress.round) && progress.round >= 1 ? progress.round : undefined;
  return { stage: progress.stage, ...(round !== undefined ? { round } : {}) };
}

/** A Step Functions error output as the progress record keeps it. */
export function stepError(error: StepFailure | null | undefined): StageError | undefined {
  if (!error?.Error) return undefined;
  return stageError(error.Error, error.Cause);
}

/** A thrown error as the progress record keeps it. */
export function thrownError(error: unknown): StageError {
  if (error instanceof Error) return stageError(error.name || 'Error', error.message);
  return stageError('Error', String(error));
}

export interface StageControl {
  /** Record the stage's start, once: for a policy with `startsInHandler`. */
  start(): Promise<void>;
}

export function staged<I extends ProgressInput, O>(
  name: string,
  keyOf: (input: I) => RunKey,
  policy: StagePolicy<I, O>,
  handler: (input: I, log: Logger, stage: StageControl) => Promise<O>,
  recorderFor: (log: Logger) => ProgressRecorder = (log) => progressRecorder(process.env, { onError: (message, fields) => log.error(message, fields) }),
): (input: I) => Promise<O> {
  return logged(name, keyOf, async (input, log) => {
    const at = stageOf(input);
    let workItemId: string | undefined;
    try {
      workItemId = keyOf(input).workItemId;
    } catch {
      // No readable id: the stage runs unrecorded, and fails on its own terms.
    }
    if (!at || !workItemId) return handler(input, log, { start: async () => {} });

    const id = workItemId;
    const recorder = recorderFor(log);
    let started = false;
    const start = async (): Promise<void> => {
      if (started) return;
      started = true;
      await recorder.started(id, at.stage, at.round);
    };

    for (const closing of policy.closes?.(input) ?? []) {
      await recorder.ended(id, closing.stage, at.round, closing.outcome, { ifOpen: true, ...(closing.error ? { error: closing.error } : {}) });
    }
    if (!policy.startsInHandler) await start();

    let result: O;
    try {
      result = await handler(input, log, { start });
    } catch (error) {
      if (started) await recorder.ended(id, at.stage, at.round, 'failed', { error: thrownError(error) });
      if (started && policy.ends?.(input, undefined)) await recorder.workItemEnded(id, policy.failure?.(input) ?? thrownError(error));
      throw error;
    }
    if (started && !policy.endsLater) await recorder.ended(id, at.stage, at.round, 'succeeded');
    if (started && policy.ends?.(input, result)) {
      const failure = policy.failure?.(input);
      await recorder.workItemEnded(id, ...(failure ? [failure] : []));
    }
    return result;
  });
}
