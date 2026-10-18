/**
 * Prepare: accept the WorkItem exactly once, then set up the agent's session
 * deterministically: clone the repository, put the session on the work branch
 * (a fresh branch off the default head, or the existing rework branch), and
 * leave the WorkItem on disk for the agent to read, with the request copied to
 * the top of /workspace/notes.md so it stays in view. For rework items, the
 * review details — including the failing checks' logs, fetched here with a
 * short-lived read-only token and redacted — are left at /workspace/rework.md.
 * No model is involved.
 *
 * The session is brand new at this point, so no agent code can be running.
 * The read-only token is sent as an HTTP header for the clone only and is not
 * written anywhere in the session.
 */
import type { CheckJob, GitHubClient } from '@factorial/github-app';
import { assertWorkItem, type ReworkContext, type WorkItem, type WorkItemReviewDetail } from '@factorial/workitem';

import { reworkContext, workBranchFor, type WorkContext } from '../lib/context.ts';
import { repositoryClient, repositoryToken } from '../lib/github.ts';
import { mustRun, sessionTarget } from '../lib/session.ts';
import {
  HARDENED_GIT_ENV,
  assertCommitSha,
  assertGitHubName,
  assertGitBranch,
  assertUuid,
  gitAuthHeader,
  redactSecrets,
  shellQuote,
} from '../lib/shell.ts';
import { acceptWorkItem, recordProgress } from '../lib/table.ts';

interface PrepareInput {
  workItem: unknown;
  factorialVersion: string;
}

export function cloneScript(params: {
  owner: string;
  name: string;
  branch: string;
  token: string;
  workItemJson: string;
  /** The initial /workspace/notes.md, from `initialNotes`. */
  notes: string;
  /** Checkout mode: a new branch off the default head, or an existing remote branch. */
  mode: 'create' | 'checkout';
}): string {
  const owner = assertGitHubName(params.owner, 'repository owner');
  const name = assertGitHubName(params.name, 'repository name');
  const branch = assertGitBranch(params.branch, 'work branch');
  const url = `https://github.com/${owner}/${name}.git`;
  const workItemBase64 = Buffer.from(params.workItemJson, 'utf8').toString('base64');
  const notesBase64 = Buffer.from(params.notes, 'utf8').toString('base64');
  const checkout =
    params.mode === 'create'
      ? `git checkout --quiet -b ${shellQuote(branch)}`
      : [`git checkout --quiet ${shellQuote(`origin/${branch}`)}`, `git branch --quiet ${shellQuote(branch)}`].join('\n');
  return [
    'set -euo pipefail',
    HARDENED_GIT_ENV,
    'rm -rf /workspace/repo /workspace/summary.md /workspace/workitem.json /workspace/rework.md /workspace/notes.md /workspace/logs',
    `git -c http.extraHeader=${shellQuote(gitAuthHeader(params.token))} clone --quiet ${shellQuote(url)} /workspace/repo`,
    'cd /workspace/repo',
    checkout,
    'git rev-parse HEAD',
    `printf '%s' ${shellQuote(workItemBase64)} | base64 -d > /workspace/workitem.json`,
    `printf '%s' ${shellQuote(notesBase64)} | base64 -d > /workspace/notes.md`,
    `git symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##'`,
  ].join('\n');
}

/**
 * The starting /workspace/notes.md: the request itself, ahead of the agent's
 * own notes. The harness drops older messages, including the prompt, so the
 * notes file is what keeps the task in view for the whole session.
 */
export function initialNotes(workItem: WorkItem, rework: boolean): string {
  return [
    '# Task',
    '',
    '_Copied from the work item by the orchestrator. Do not edit this section; re-read it before you plan, before each commit and before writing summary.md._',
    '',
    `Source: ${workItem.source.url}`,
    '',
    `## ${workItem.title}`,
    '',
    workItem.body.trim() || '_No further description was given._',
    ...(rework ? ['', 'This is rework: every point in /workspace/rework.md must be addressed.'] : []),
    '',
    '# Plan',
    '',
    '_Write the plan here before changing any code: each requirement above, and the change that meets it._',
    '',
    '# Notes',
    '',
  ].join('\n');
}

/** The last lines of a failing job's log, secrets stripped, as a Markdown section. */
export function logSection(job: CheckJob, log: string, tailLines = 200): string {
  const tail = log.split('\n').slice(-tailLines).join('\n');
  return [
    `### Failing job: ${job.name} (${job.htmlUrl})`,
    '',
    '```text',
    redactSecrets(tail.trimEnd()),
    '```',
  ].join('\n');
}

/**
 * `/workspace/rework.md`: the review details to address, plus — when the cause
 * is failed checks — the failing jobs and the tail of each of their logs.
 * Everything comes from untrusted text and is redacted before it is written
 * into the session.
 */
export async function buildReworkFile(
  client: GitHubClient,
  repo: { owner: string; name: string },
  headSha: string,
  rework: ReworkContext,
): Promise<string> {
  const lines: string[] = [
    `# Rework of pull request #${rework.pullRequest.number}`,
    '',
    `Previous work item: ${rework.previousWorkItemId}`,
    `Pull request: ${rework.pullRequest.url}`,
    `Cause: ${rework.cause === 'review' ? 'review comments' : 'failed checks'}`,
    '',
    '## Points to address',
    '',
  ];
  if (rework.details.length === 0) {
    lines.push('_No specific points were recorded; see the pull request._');
  }
  for (const detail of rework.details) {
    lines.push(...detailSection(detail));
  }
  if (rework.cause === 'checks-failed') {
    const jobs = await client.listJobsForHeadSha(repo, headSha);
    const failing = jobs.filter((job) => job.conclusion === 'failure');
    lines.push('', '## Failing checks', '');
    if (failing.length === 0) {
      lines.push('_The checks are no longer reported as failing on the branch head._');
    }
    for (const job of failing) {
      lines.push('', logSection(job, await client.getJobLog(repo, job.id)));
    }
  }
  return `${lines.join('\n')}\n`;
}

function detailSection(detail: WorkItemReviewDetail): string[] {
  const where = detail.path
    ? ` (${detail.path}${detail.line === undefined ? '' : `:${detail.line}`})`
    : '';
  return [`- **@${detail.author}${where}**`, '', redactSecrets(detail.body.trim()), ''];
}

export const handler = async (input: PrepareInput): Promise<WorkContext> => {
  assertWorkItem(input.workItem);
  const workItem = input.workItem;
  assertUuid(workItem.id, 'WorkItem id');

  await acceptWorkItem(workItem, input.factorialVersion);

  const repo = { owner: workItem.repository.owner, name: workItem.repository.name };
  const rework = reworkContext(workItem);
  const branch = workBranchFor(workItem);
  const token = await repositoryToken(repo, { contents: 'read' });
  const target = sessionTarget(workItem.id);

  const result = await mustRun(
    target,
    cloneScript({
      owner: repo.owner,
      name: repo.name,
      branch,
      token,
      workItemJson: JSON.stringify(workItem, null, 2),
      notes: initialNotes(workItem, rework !== undefined),
      mode: rework ? 'checkout' : 'create',
    }),
    600,
  );
  const stdoutLines = result.stdout.trim().split('\n');
  const baseCommit = assertCommitSha(stdoutLines[stdoutLines.length - 2] ?? '', 'branch head');
  const baseBranch = rework ? rework.baseBranch : stdoutLines[stdoutLines.length - 1] ?? 'main';

  if (rework) {
    const client = await repositoryClient(repo, { contents: 'read', actions: 'read' });
    const reworkFile = await buildReworkFile(client, repo, baseCommit, rework);
    const encoded = Buffer.from(reworkFile, 'utf8').toString('base64');
    await mustRun(
      target,
      [`set -euo pipefail`, `printf '%s' ${shellQuote(encoded)} | base64 -d > /workspace/rework.md`].join('\n'),
      60,
    );
  }

  await recordProgress(workItem.id, 'prepared', {
    branch,
    baseBranch,
    sessionId: workItem.id,
    ...(rework ? { reworkOf: { previousWorkItemId: rework.previousWorkItemId, prNumber: rework.pullRequest.number } } : {}),
  });
  console.log(
    JSON.stringify({
      message: 'session prepared',
      workItemId: workItem.id,
      branch,
      baseBranch,
      rework: rework !== undefined,
    }),
  );

  return {
    workItem,
    sessionId: workItem.id,
    branch,
    baseBranch,
    baseCommit,
    factorialVersion: input.factorialVersion,
  };
};
