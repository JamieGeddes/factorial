/**
 * PrepareVerify (#167): set up one verifier's session. Each verifier the
 * target declares runs in a fresh session of its own on the verifier Runtime
 * (`factorial_verifier`), whose execution role can call no model and reach
 * none of Factorial's data. This step seeds the work branch there from a
 * bundle (`lib/repo-seed.ts`), as PrepareReview does, and fails unless the
 * remote branch is still at the commit Collect pushed: every verifier runs on
 * that commit. Nothing else is written; the workspace is then the agent
 * user's. No token enters the session: the bundle was fetched here.
 *
 * The invoker runs the check next (RunVerifier), and CollectVerifier judges
 * it. A failure here is the verifier's `error` outcome, recorded by
 * CollectVerifier, so the Verify stage stays open (`failureEndsLater`).
 */
import { verifierSessionId, type Verifier } from '@factorial/verifiers';

import type { WorkContext } from '../lib/context.ts';
import { runKey } from '../lib/log.ts';
import { staged, type ProgressInput, type StagePolicy } from '../lib/progress.ts';
import { handOverWorkspace } from '../lib/session.ts';
import { assertCommitSha } from '../lib/shell.ts';
import { recordProgress } from '../lib/table.ts';

import { seedCheckout, type CheckoutParams } from './prepare.ts';

export interface PrepareVerifyInput extends ProgressInput {
  ctx: WorkContext;
  collect: { headSha: string };
  verifier: Verifier;
  /** The verifier's place in the declared list, from 0. */
  index: number;
}

export interface PrepareVerifyResult {
  sessionId: string;
}

/** The Verify stage starts with the first verifier and ends once all have run: PrepareReview or Report ends it. */
export const prepareVerifyStage: StagePolicy<PrepareVerifyInput, PrepareVerifyResult> = { endsLater: true, failureEndsLater: true };

/** The checkout a verifier's session gets: the work branch, at the tested commit. */
export function verifierCheckout(input: PrepareVerifyInput): CheckoutParams {
  const { ctx, verifier, index } = input;
  return {
    role: 'verifier',
    workItem: ctx.workItem,
    branch: ctx.branch,
    at: assertCommitSha(input.collect.headSha, 'tested head'),
    existing: true,
    sessionId: verifierSessionId(ctx.workItem.id, index),
    artefactPrefix: ctx.artefactPrefix,
    stage: `verify/${verifier.name}`,
    ...(ctx.rework ? { rework: ctx.rework } : {}),
  };
}

export const handler = staged('prepare-verify', (input: PrepareVerifyInput) => runKey(input.ctx), prepareVerifyStage, async (input, log): Promise<PrepareVerifyResult> => {
  const params = verifierCheckout(input);
  const seeded = await seedCheckout(params);
  await handOverWorkspace(seeded.target);
  await recordProgress(input.ctx.workItem.id, 'verifying', { testedSha: params.at });
  log.info('verifier session prepared', { verifier: input.verifier.name, sessionId: params.sessionId, sha: params.at });
  return { sessionId: seeded.target.sessionId };
});
