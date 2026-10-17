/**
 * Open the pull request for human approval and tell the requester where it is.
 */
import { issueNumber, type WorkContext } from '../lib/context.ts';
import { repositoryClient } from '../lib/github.ts';
import { recordProgress } from '../lib/table.ts';

import { pullRequestBody, type TestResult } from './pr-body.ts';

interface OpenPrInput {
  ctx: WorkContext;
  collect: { headSha: string; summary: string };
  test: TestResult;
}

export const handler = async (input: OpenPrInput): Promise<{ prNumber: number; prUrl: string }> => {
  const { ctx } = input;
  const repo = { owner: ctx.workItem.repository.owner, name: ctx.workItem.repository.name };
  const client = await repositoryClient(repo, { pull_requests: 'write', issues: 'write' });

  const pr = await client.createPullRequest(repo, {
    title: ctx.workItem.title,
    body: pullRequestBody(ctx, input.collect.summary, input.test, input.collect.headSha),
    head: ctx.branch,
    base: ctx.baseBranch,
  });

  const issue = issueNumber(ctx.workItem);
  if (issue !== undefined) {
    await client.commentOnIssue(repo, issue, `Factorial has opened ${pr.htmlUrl} for review.`);
  }

  await recordProgress(ctx.workItem.id, 'pr-opened', { prUrl: pr.htmlUrl, prNumber: pr.number, testRunUrl: input.test.runUrl });
  console.log(JSON.stringify({ message: 'pull request opened', workItemId: ctx.workItem.id, prUrl: pr.htmlUrl }));
  return { prNumber: pr.number, prUrl: pr.htmlUrl };
};
