/**
 * What a verifier task's exit status means (#167), shared by the check runner
 * that sets it (packages/agent-runtime/src/verifier/) and CollectVerifier,
 * which reads it from the ECS task. No dependencies, so the runner's bundle
 * carries none of the contract validation.
 */
import type { VerifierOutcome } from './types.ts';

/** The container that runs the check in the verifier task definition (templates/orchestration.yml). */
export const VERIFIER_CONTAINER = 'verifier';

/** The runner's status for a check it could not start: the seed, the npm mirror or its input failed. `timeout` uses 125 for the same. */
export const SETUP_FAILED = 125;

/** How long `timeout` waits after its TERM before it kills the check. */
export const KILL_AFTER_SECONDS = 30;

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
  if (exitCode < 0) return { outcome: 'error', detail: 'the check ended without an exit status' };
  return { outcome: 'failed' };
}
