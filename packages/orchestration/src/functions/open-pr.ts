/**
 * Open the pull request for human approval and tell the requester where it is.
 * Before opening it, confirm that the branch still points at the commit that
 * was tested, so the PR cannot present untested code.
 */
import { issueNumber, reworkContext, type WorkContext } from '../lib/context.ts';
import { repositoryClient } from '../lib/github.ts';
import { assertCommitSha } from '../lib/shell.ts';
import { recordProgress } from '../lib/table.ts';

import { pullRequestBody, type TestResult } from './pr-body.ts';

interface OpenPrInput {
  ctx: WorkContext;
  collect: { headSha: string; summary: string };
  test: TestResult & { sha?: string };
}

export class UntestedHeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UntestedHead';
  }
}

/** The comment posted on an existing pull request when rework is pushed. */
export function reworkComment(ctx: WorkContext, summary: string, test: TestResult, headSha: string): string {
  return ['Factorial has pushed the reworked changes for review.', '', pullRequestBody(ctx, summary, test, headSha)].join('\n');
}

export const handler = async (input: OpenPrInput): Promise<{ prNumber: number; prUrl: string }> => {
  const { ctx } = input;
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
    if (rework !== undefined) {
      // Rework: the pull request already exists, so comment on it with the
      // update instead of opening a second one. Pull request comments go
      // through the Issues API, so they need the issues: write permission
      // granted above.
      await client.commentOnPullRequest(repo, rework.pullRequest.number, reworkComment(ctx, input.collect.summary, input.test, headSha));
    await recordProgress(ctx.workItem.id, 'rework-pushed', {
      prUrl: rework.pullRequest.url,
      prNumber: rework.pullRequest.number,
      testRunUrl: input.test.runUrl,
    });
    console.log(JSON.stringify({
      message: 'rework pushed',
      workItemId: ctx.workItem.id,
      prUrl: rework.pullRequest.url,
    }));
    return { prNumber: rework.pullRequest.number, prUrl: rework.pullRequest.url };
  }

  const pr = await client.createPullRequest(repo, {
    title: ctx.workItem.title,
    body: pullRequestBody(ctx, input.collect.summary, input.test, headSha),
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
