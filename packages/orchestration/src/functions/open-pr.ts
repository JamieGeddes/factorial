/**
 * Open the pull request for human approval and tell the requester where it is.
 * Before opening it, confirm that the branch still points at the commit that
 * was tested, so the PR cannot present untested code.
 */
import { putJsonArtefact } from '@factorial/artefacts';

import { issueNumber, type WorkContext } from '../lib/context.ts';
import { repositoryClient } from '../lib/github.ts';
import { logged, runKey } from '../lib/log.ts';
import type { PlanDigest } from '../lib/plan-files.ts';
import { assertCommitSha } from '../lib/shell.ts';
import { recordProgress } from '../lib/table.ts';
import { testResultArtefact } from '../lib/test-result.ts';

import { pullRequestBody, type ReviewOutcome, type TestResult } from './pr-body.ts';

interface OpenPrInput {
  ctx: WorkContext;
  collect: { headSha: string; summary: string };
  test: TestResult & { sha?: string };
  /** The plan the builder followed; absent for runs started before the Plan stage. */
  plan?: PlanDigest | null;
  /** The Review stage's outcome: null when it failed outright, absent for runs started before the stage. */
  review?: ReviewOutcome;
}

export class UntestedHeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UntestedHead';
  }
}

type OpenPrResult = { prNumber: number; prUrl: string };

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

  const pr = await client.createPullRequest(repo, {
    title: ctx.workItem.title,
    body: pullRequestBody(ctx, input.collect.summary, input.test, headSha, input.plan ?? undefined, input.review),
    head: ctx.branch,
    base: ctx.baseBranch,
  });

  const issue = issueNumber(ctx.workItem);
  if (issue !== undefined) {
    await client.commentOnIssue(repo, issue, `Factorial has opened ${pr.htmlUrl} for review.`);
  }

  await recordProgress(ctx.workItem.id, 'pr-opened', { prUrl: pr.htmlUrl, prNumber: pr.number, testRunUrl: input.test.runUrl });
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
