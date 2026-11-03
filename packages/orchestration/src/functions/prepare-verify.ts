/**
 * PrepareVerify (#167): get one verifier's task its code. Each verifier the
 * target declares runs in a fresh Fargate task from the agent image
 * (RunVerifier), whose role reaches nothing of Factorial's and which never
 * reaches GitHub. This step fetches the work branch and the default branch
 * (`lib/repo-seed.ts`), fails unless the work branch is still at the commit
 * Collect pushed, since every verifier runs on that commit, and puts them in
 * the transfer bucket as a bundle, with a URL presigned for fifteen minutes.
 * The task downloads it and sets the repository up itself; no token reaches
 * the task. CollectVerifier deletes the bundle once the task has ended.
 *
 * A failure here is the verifier's `error` outcome, recorded by
 * CollectVerifier, so the Verify stage stays open (`failureEndsLater`).
 */
import type { Verifier } from '@factorial/verifiers';

import type { WorkContext } from '../lib/context.ts';
import { runKey } from '../lib/log.ts';
import { staged, type ProgressInput, type StagePolicy } from '../lib/progress.ts';
import { bundleForTask, type TaskBundleParams } from '../lib/repo-seed.ts';
import { assertCommitSha } from '../lib/shell.ts';
import { recordProgress } from '../lib/table.ts';
import { transferKey } from '../lib/transfer.ts';

export interface PrepareVerifyInput extends ProgressInput {
  ctx: WorkContext;
  collect: { headSha: string };
  verifier: Verifier;
  /** The verifier's place in the declared list, from 0. */
  index: number;
}

/** What the task needs to set the repository up: passed to it in the container overrides. */
export interface PrepareVerifyResult {
  bundleUrl: string;
  defaultBranch: string;
  /** `<owner>/<name>`, for the checkout's `origin`, which is never contacted. */
  repository: string;
}

/** The Verify stage starts with the first verifier and ends once all have run: PrepareReview or Report ends it. */
export const prepareVerifyStage: StagePolicy<PrepareVerifyInput, PrepareVerifyResult> = { endsLater: true, failureEndsLater: true };

/** Where a verifier's bundle goes in the transfer bucket: CollectVerifier deletes the same key. */
export const verifierBundleKey = (ctx: Pick<WorkContext, 'artefactPrefix'>, verifier: Pick<Verifier, 'name'>): string =>
  transferKey(ctx.artefactPrefix, `verify/${verifier.name}`, 'repo.bundle');

/** The bundle a verifier's task gets: the work branch, at the tested commit, with a rework's base branch. */
export function verifierBundle(input: PrepareVerifyInput): TaskBundleParams {
  const { ctx, verifier } = input;
  return {
    repository: { owner: ctx.workItem.repository.owner, name: ctx.workItem.repository.name },
    transferKey: verifierBundleKey(ctx, verifier),
    branch: ctx.branch,
    at: assertCommitSha(input.collect.headSha, 'tested head'),
    ...(ctx.rework ? { baseBranch: ctx.rework.baseBranch } : {}),
  };
}

export const handler = staged('prepare-verify', (input: PrepareVerifyInput) => runKey(input.ctx), prepareVerifyStage, async (input, log): Promise<PrepareVerifyResult> => {
  const params = verifierBundle(input);
  const { bundleUrl, defaultBranch } = await bundleForTask(params);
  await recordProgress(input.ctx.workItem.id, 'verifying', { testedSha: params.at });
  log.info('verifier bundle ready', { verifier: input.verifier.name, sha: params.at, key: params.transferKey });
  return { bundleUrl, defaultBranch, repository: `${params.repository.owner}/${params.repository.name}` };
});
