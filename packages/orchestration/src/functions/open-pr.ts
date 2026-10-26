/**
 * Open the pull request for human approval and tell the requester where it is.
 * Before opening it, confirm that the branch still points at the commit that
 * was tested, so the PR cannot present untested code.
 *
 * A rework item's branch already has a pull request. Instead of opening
 * another, the same checks run and Factorial replies on that pull request,
 * answering each point, and re-requests review from whoever asked for the
 * changes. The state machine takes the same path for both.
 */
import { getTextArtefact, putJsonArtefact, redactSecrets } from '@factorial/artefacts';
import type { GitHubClient, Repo } from '@factorial/github-app';
import { parsePlanJson, type Plan } from '@factorial/plan';
import type { ReworkContext } from '@factorial/workitem';

import { issueNumber, reworkContext, type WorkContext } from '../lib/context.ts';
import { repositoryClient } from '../lib/github.ts';
import { logged, runKey, type Logger } from '../lib/log.ts';
import { MAX_PLAN_ARTEFACT_BYTES } from '../lib/review-files.ts';
import type { PlanDigest } from '../lib/plan-files.ts';
import type { PrFacts } from '../lib/pr-facts.ts';
import { assertCommitSha } from '../lib/shell.ts';
import type { ReworkPoint } from '../lib/rework-admission.ts';
import { pullRequestKey, recordProgress } from '../lib/table.ts';
import { testResultArtefact } from '../lib/test-result.ts';

import { pullRequestBody, reworkComment, safeLogin, type ReviewOutcome, type TestResult } from './pr-body.ts';

interface OpenPrInput {
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
export function reviewersToRequest(rework: ReworkContext, points: readonly ReworkPoint[] = rework.details): string[] {
  if (rework.cause !== 'review') return [];
  const logins = points.map((d) => safeLogin(d.author)).filter((l): l is string => l !== undefined && !l.endsWith('[bot]'));
  return [...new Set(logins)];
}

/** Reply on the rework's pull request and ask its reviewers to look again. The reply must land; the re-request may fail. */
async function replyToRework(
  input: OpenPrInput,
  rework: ReworkContext,
  client: GitHubClient,
  repo: Repo,
  headSha: string,
  log: Logger,
): Promise<OpenPrResult> {
  const { ctx } = input;
  const pr = rework.pullRequest;
  await client.commentOnIssue(
    repo,
    pr.number,
    reworkComment(ctx, rework, redactSecrets(input.collect.summary), input.test, headSha, { review: input.review, facts: input.prFacts }),
  );
  const reviewers = reviewersToRequest(rework, ctx.reworkPoints);
  if (reviewers.length > 0) {
    try {
      await client.requestReviewers(repo, pr.number, reviewers);
    } catch (error) {
      // A reviewer who has lost access, or the requester themselves, is
      // refused by GitHub; the reply already names them.
      log.error('review not re-requested', { error, reviewers });
    }
  }
  await recordProgress(ctx.workItem.id, 'pr-updated', { prUrl: pr.url, prNumber: pr.number, testRunUrl: input.test.runUrl });
  try {
    await putJsonArtefact(ctx.artefactPrefix, 'pr/pr.json', { number: pr.number, url: pr.url, headSha, rework: true });
    await putJsonArtefact(ctx.artefactPrefix, 'report.json', { outcome: 'pr-updated', reason: `Pull request #${pr.number} updated with the rework.` });
  } catch (error) {
    log.error('artefacts not stored', { error });
  }
  log.info('pull request updated', { prUrl: pr.url, reviewers });
  return { prNumber: pr.number, prUrl: pr.url };
}

export const handler = logged('open-pr', (input: OpenPrInput) => runKey(input.ctx), async (input, log): Promise<OpenPrResult> => {
  const { ctx } = input;
  await putJsonArtefact(ctx.artefactPrefix, 'test/result.json', testResultArtefact(input.test));
  const headSha = assertCommitSha(input.collect.headSha, 'head sha');
  if (input.test.sha !== undefined && input.test.sha !== headSha) {
    throw new UntestedHeadError(`tests ran on ${input.test.sha}, but the branch head is ${headSha}`);
  }

  const repo = { owner: ctx.workItem.repository.owner, name: ctx.workItem.repository.name };
  const client = await repositoryClient(repo, { contents: 'read', pull_requests: 'write', issues: 'write' });

  const remoteHead = await client.getBranchSha(repo, ctx.branch);
  if (remoteHead !== headSha) {
    throw new UntestedHeadError(`branch ${ctx.branch} now points at ${remoteHead}, not the tested ${headSha}`);
  }

  const rework = reworkContext(ctx.workItem);
  if (rework) return replyToRework(input, rework, client, repo, headSha, log);

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

  const issue = issueNumber(ctx.workItem);
  if (issue !== undefined) {
    await client.commentOnIssue(repo, issue, `Factorial has opened ${pr.htmlUrl} for review.`);
  }

  await recordProgress(ctx.workItem.id, 'pr-opened', {
    prUrl: pr.htmlUrl,
    prNumber: pr.number,
    pullRequestKey: pullRequestKey(repo, pr.number),
    testRunUrl: input.test.runUrl,
  });
  // The pull request is open, so a failure to record it must not turn the run
  // into a reported failure.
  try {
    await putJsonArtefact(ctx.artefactPrefix, 'pr/pr.json', { number: pr.number, url: pr.htmlUrl, headSha });
    await putJsonArtefact(ctx.artefactPrefix, 'report.json', { outcome: 'pr-opened', reason: `Pull request #${pr.number} opened for review.` });
  } catch (error) {
    log.error('artefacts not stored', { error });
  }
  log.info('pull request opened', { prUrl: pr.htmlUrl });
  return { prNumber: pr.number, prUrl: pr.htmlUrl };
});
