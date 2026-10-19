/**
 * Logging for the orchestrator Lambdas, in the shape shared with the invoker
 * (`@factorial/log`): one JSON object per line, carrying `workItemId`,
 * `attempt` and `stage`.
 */
import { createLogger, type Logger, type RunKey } from '@factorial/log';

import type { WorkContext } from './context.ts';

export type { Logger, RunKey } from '@factorial/log';

export function runKey(ctx: Pick<WorkContext, 'workItem' | 'attempt'>): RunKey {
  return { workItemId: ctx.workItem.id, attempt: ctx.attempt };
}

/** The work item id from an input not yet validated, if it has a string one. */
export function unvalidatedId(workItem: unknown): string | undefined {
  const id = (workItem as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * A Lambda handler that logs its failure with the run's key before the error
 * reaches Step Functions; the runtime's own error line carries no id.
 * `keyOf` reads the key from the raw input and must not assume it is valid.
 */
export function logged<I, O>(
  stage: string,
  keyOf: (input: I) => RunKey,
  handler: (input: I, log: Logger) => Promise<O>,
  write?: (line: string) => void,
): (input: I) => Promise<O> {
  return async (input) => {
    let key: RunKey = {};
    try {
      key = keyOf(input);
    } catch {
      // An input without a readable key is still handled; its lines carry none.
    }
    const log = createLogger(stage, key, write);
    try {
      return await handler(input, log);
    } catch (error) {
      log.error('failed', { error });
      throw error;
    }
  };
}
