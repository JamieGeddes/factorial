/**
 * Open the pull request for human approval. Before opening it, confirm that
 * the branch still points at the commit that was tested, so the PR cannot
 * present untested code.
 *
 * A rework item's branch already has a pull request. Instead of opening
 * another, the same checks run and the pull request is recorded as updated.
 * The state machine takes the same path for both.
 *
 * Either way the turn ends with an outcome (#165): `report.json` carries
 * what the reply needs, and the reporter for the item's source tells the
 * requester (the issue's "opened" comment; on a rework, the reply answering
 * each point and the review re-request). Opening the pull request is a
 * repository operation and stays here; telling anyone is not.
 */
import { getTextArtefact, putJsonArtefact, redactSecrets } from '@factorial/artefacts';
import { parsePlanJson, type Plan } from '@factorial/plan';
import type { ReworkTurn, WorkContext } from '../lib/context.ts';
import { repositoryClient } from '../lib/github.ts';
import { runKey, type Logger } from '../lib/log.ts';
import { emitOutcome } from '../lib/outcome.ts';
import { staged, type ProgressInput, type StagePolicy } from '../lib/progress.ts';
import { MAX_PLAN_ARTEFACT_BYTES } from '../lib/review-files.ts';
import type { PlanDigest } from '../lib/plan-files.ts';
import type { PrFacts } from '../lib/pr-facts.ts';
import { REPORT_ARTEFACT, type ReportFile } from '../lib/report-file.ts';
import { assertCommitSha } from '../lib/shell.ts';
import type { ReworkPoint } from '../lib/rework-points.ts';
import { pullRequestKey, recordProgress } from '../lib/table.ts';
import { recordThreadPullRequest } from '../lib/thread.ts';
import { testResultArtefact } from '../lib/test-result.ts';

import { pullRequestBody, reworkReplyFacts, safeLogin, type ReviewOutcome, type TestResult } from './pr-body.ts';

interface OpenPrInput extends ProgressInput {
  ctx: WorkContext;
  collect: { headSha: string; summary: string };
  test: TestResult & { sha?: string };
  /** The plan the builder followed; absent for runs started before the Plan stage. */
  plan?: PlanDigest | null;
  /** The Review stage's outcome: null when it failed outright, absent for runs started before the stage. */
  review?: ReviewOutcome;
  /** What PrepareReview computed; absent when that stage failed. */
  prFacts?: PrFacts | null;
}

export class UntestedHeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UntestedHead';
  }
}

type OpenPrResult = { prNumber: number; prUrl: string };

/**
 * The plan as stored, for the untruncated step list. It is read back from the
 * artefact store, redacted and validated again; any failure leaves the state's
 * shortened copy to be used, since the pull request must open regardless.
 */
async function storedPlan(ctx: WorkContext, log: Logger): Promise<Plan | undefined> {
  try {
    const read = await getTextArtefact(ctx.artefactPrefix, 'plan/plan.json', MAX_PLAN_ARTEFACT_BYTES);
    if (!read) return undefined;
    const parsed = parsePlanJson(redactSecrets(read.text));
    return parsed.ok ? parsed.value : undefined;
  } catch (error) {
    log.error('could not read the stored plan', { error });
    return undefined;
  }
}

/**
 * Whom to ask to review again after a review-caused rework: the distinct
 * people who raised its points, never a bot (GitHub refuses those, and
 * Factorial's own comments never count).
 */
export function reviewersToRequest(rework: Pick<ReworkTurn, 'cause'>, points: readonly ReworkPoint[] = []): string[] {
  if (rework.cause !== 'review') return [];
  const logins = points.map((d) => safeLogin(d.author)).filter((l): l is string => l !== undefined && !l.endsWith('[bot]'));
  return [...new Set(logins)];
}

/**
 * Write `report.json`, then emit the outcome that points at it. The pull
 * request is open (or updated) by now, so a failure here must not turn the
 * turn into a reported failure: it is logged, and the outcome on the ledger
 * row and in the artefact store says what happened.
 */
async function endTurn(ctx: WorkContext, report: ReportFile, outcome: Parameters<typeof emitOutcome>[0], log: Logger): Promise<void> {
  try {
    await putJsonArtefact(ctx.artefactPrefix, REPORT_ARTEFACT, report);
    const emitted = await emitOutcome(outcome);
    log.info('outcome emitted', { result: emitted.result });
  } catch (error) {
    log.error('outcome not emitted', { error });
  }
}

/** Record the rework on its pull request; the reporter replies there and asks its reviewers to look again. */
async function recordRework(input: OpenPrInput, rework: ReworkTurn, headSha: string, log: Logger): Promise<OpenPrResult> {
  const { ctx } = input;
  const pr = rework.pullRequest;
  await recordProgress(ctx.workItem.id, 'pr-updated', { prUrl: pr.url, prNumber: pr.number, testRunUrl: input.test.runUrl });
  try {
    await putJsonArtefact(ctx.artefactPrefix, 'pr/pr.json', { number: pr.number, url: pr.url, headSha, rework: true });
  } catch (error) {
    log.error('artefacts not stored', { error });
  }
  const reply = reworkReplyFacts(ctx, rework, redactSecrets(input.collect.summary), input.test, headSha, { review: input.review, facts: input.prFacts });
  await endTurn(
    ctx,
    {
      outcome: 'pr-updated',
      reason: `Pull request #${pr.number} updated with the rework.`,
      delivery: { kind: 'rework-reply', reply, reviewers: reviewersToRequest(rework, ctx.reworkPoints) },
    },
    { workItem: ctx.workItem, attempt: ctx.attempt, artefactPrefix: ctx.artefactPrefix, result: 'pr-updated', route: 'change', threadKey: ctx.threadKey, pullRequest: pr, branch: ctx.branch, testedSha: headSha },
    log,
  );
  log.info('pull request updated', { prUrl: pr.url });
  return { prNumber: pr.number, prUrl: pr.url };
}

/** A pull request opened or answered ends the work item; a failure goes on to ReportFailure, which ends it. */
const openPrStage: StagePolicy<OpenPrInput, OpenPrResult> = { ends: (_input, result) => result !== undefined };

export const handler = staged('open-pr', (input: OpenPrInput) => runKey(input.ctx), openPrStage, async (input, log): Promise<OpenPrResult> => {
  const { ctx } = input;
  await putJsonArtefact(ctx.artefactPrefix, 'test/result.json', testResultArtefact(input.test));
  const headSha = assertCommitSha(input.collect.headSha, 'head sha');
  if (input.test.sha !== undefined && input.test.sha !== headSha) {
    throw new UntestedHeadError(`tests ran on ${input.test.sha}, but the branch head is ${headSha}`);
  }

  const repo = { owner: ctx.workItem.repository.owner, name: ctx.workItem.repository.name };
  const client = await repositoryClient(repo, { contents: 'read', pull_requests: 'write' });

  const remoteHead = await client.getBranchSha(repo, ctx.branch);
  if (remoteHead !== headSha) {
    throw new UntestedHeadError(`branch ${ctx.branch} now points at ${remoteHead}, not the tested ${headSha}`);
  }

  if (ctx.rework) return recordRework(input, ctx.rework, headSha, log);

  const fullPlan = await storedPlan(ctx, log);
  const pr = await client.createPullRequest(repo, {
    title: ctx.workItem.title,
    body: pullRequestBody(ctx, redactSecrets(input.collect.summary), input.test, headSha, {
      plan: input.plan,
      fullPlan,
      review: input.review,
      facts: input.prFacts,
    }),
    head: ctx.branch,
    base: ctx.baseBranch,
  });

  await recordProgress(ctx.workItem.id, 'pr-opened', {
    prUrl: pr.htmlUrl,
    prNumber: pr.number,
    testRunUrl: input.test.runUrl,
  });
  // The pull request is open, so a failure to record it must not turn the run
  // into a reported failure. The thread is how a later turn on the pull
  // request finds its branch and opener: without it, Intake refuses such a
  // turn as not Factorial's, and the error below says why.
  try {
    await recordThreadPullRequest(ctx.threadKey, { pullRequestKey: pullRequestKey(repo, pr.number), number: pr.number, openedBy: ctx.workItem.id });
  } catch (error) {
    log.error('pull request not recorded on its thread', { error, threadKey: ctx.threadKey });
  }
  try {
    await putJsonArtefact(ctx.artefactPrefix, 'pr/pr.json', { number: pr.number, url: pr.htmlUrl, headSha });
  } catch (error) {
    log.error('artefacts not stored', { error });
  }
  await endTurn(
    ctx,
    { outcome: 'pr-opened', reason: `Pull request #${pr.number} opened for review.`, delivery: { kind: 'pr-opened' } },
    {
      workItem: ctx.workItem,
      attempt: ctx.attempt,
      artefactPrefix: ctx.artefactPrefix,
      result: 'pr-opened',
      route: 'change',
      threadKey: ctx.threadKey,
      pullRequest: { number: pr.number, url: pr.htmlUrl },
      branch: ctx.branch,
      testedSha: headSha,
    },
    log,
  );
  log.info('pull request opened', { prUrl: pr.htmlUrl });
  return { prNumber: pr.number, prUrl: pr.htmlUrl };
});
