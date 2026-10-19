/**
 * Prepare: accept the WorkItem exactly once, then set up the agent's session
 * deterministically: clone the repository, put the session on the work branch
 * (a fresh branch off the default head, or the existing rework branch), and
 * leave the WorkItem on disk for the agent to read, with the request copied to
 * the top of /workspace/notes.md so it stays in view. When an earlier attempt
 * at the same source failed but saved its work, the session resumes on that
 * attempt's branch instead of starting afresh. For rework items, the
 * review details — including the failing checks' logs, fetched here with a
 * short-lived read-only token and redacted — are left at /workspace/rework.md.
 * No model is involved.
 *
 * The session is brand new at this point, so no agent code can be running.
 * The read-only token is sent as an HTTP header for the clone only and is not
 * written anywhere in the session.
 */
import { artefactPrefix, putJsonArtefact, redactSecrets } from '@factorial/artefacts';
import type { CheckJob, GitHubClient } from '@factorial/github-app';
import { assertWorkItem, type ReworkContext, type WorkItem, type WorkItemReviewDetail } from '@factorial/workitem';

import { reworkContext, workBranchFor, type WorkContext } from '../lib/context.ts';
import { nextAttempt, resumableAttempt, type Attempt } from '../lib/resume.ts';
import { repositoryClient, repositoryToken } from '../lib/github.ts';
import { mustRun, sessionTarget } from '../lib/session.ts';
import {
  HARDENED_GIT_ENV,
  assertCommitSha,
  assertGitHubName,
  assertGitBranch,
  assertUuid,
  gitAuthHeader,
  shellQuote,
} from '../lib/shell.ts';
import { acceptWorkItem, attemptRecord, attemptsAtSource, recordProgress } from '../lib/table.ts';

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
export function initialNotes(workItem: WorkItem, options: { rework?: boolean; resumedFrom?: Attempt } = {}): string {
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
    ...(options.rework ? ['', 'This is rework: every point in /workspace/rework.md must be addressed.'] : []),
    ...(options.resumedFrom ? ['', ...previousAttemptSection(options.resumedFrom)] : []),
    '',
    '# Plan',
    '',
    '_Write the plan here before changing any code: each requirement above, and the change that meets it._',
    '',
    '# Notes',
    '',
  ].join('\n');
}

function previousAttemptSection(attempt: Attempt): string[] {
  const how = attempt.status === 'tests-failed' ? 'finished, but its tests failed' : 'stopped before finishing';
  return [
    '# Previous attempt',
    '',
    `This continues work item ${attempt.workItemId}, which ${how}. Its commits are already on this branch.`,
    'Before planning, run `git log --oneline origin/HEAD..HEAD` and `git diff --stat origin/HEAD...HEAD` to see what was done, and check it against the Task.',
    'Plan only what remains. Do not redo work that is already committed.',
  ];
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

/**
 * The earlier attempt to resume, if any, and only while its branch still
 * exists. Any failure to tell (a lookup error, a deleted branch) starts the
 * item afresh, as before.
 */
async function resumable(repo: { owner: string; name: string }, workItem: WorkItem): Promise<Attempt | undefined> {
  try {
    const attempt = resumableAttempt(await attemptsAtSource(workItem), workItem.id);
    if (!attempt?.branch) return undefined;
    const branch = assertGitBranch(attempt.branch, 'resume branch');
    if (!branch.startsWith('factorial/')) return undefined;
    const client = await repositoryClient(repo, { contents: 'read' });
    await client.getBranchSha(repo, branch);
    const record = await attemptRecord(attempt.workItemId);
    return { ...attempt, branch, ...(record?.attempt === undefined ? {} : { attempt: record.attempt }) };
  } catch (error) {
    console.log(JSON.stringify({ message: 'not resuming', workItemId: workItem.id, error: String(error) }));
    return undefined;
  }
}

export const handler = async (input: PrepareInput): Promise<WorkContext> => {
  assertWorkItem(input.workItem);
  const workItem = input.workItem;
  assertUuid(workItem.id, 'WorkItem id');

  const repo = { owner: workItem.repository.owner, name: workItem.repository.name };
  const rework = reworkContext(workItem);
  // Looked up before accepting, so the row is written with its attempt
  // number. The lookup only reads, so a duplicate delivery changes nothing.
  const resumedFrom = rework ? undefined : await resumable(repo, workItem);
  const attempt = nextAttempt(resumedFrom);
  const prefix = artefactPrefix(workItem.id, attempt);

  await acceptWorkItem(workItem, input.factorialVersion, attempt);
  await putJsonArtefact(prefix, 'workitem.json', workItem);

  const branch = resumedFrom?.branch ?? workBranchFor(workItem);
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
      notes: initialNotes(workItem, { rework: rework !== undefined, ...(resumedFrom ? { resumedFrom } : {}) }),
      mode: rework || resumedFrom ? 'checkout' : 'create',
    }),
    600,
  );
  const stdoutLines = result.stdout.trim().split('\n');
  const baseCommit = assertCommitSha(stdoutLines[stdoutLines.length - 2] ?? '', 'branch head');
  const baseBranch = rework ? rework.baseBranch : stdoutLines[stdoutLines.length - 1] ?? 'main';

  await putJsonArtefact(prefix, 'prepare/branch.json', {
    branch,
    baseSha: baseCommit,
    factorialVersion: input.factorialVersion,
    ...(resumedFrom ? { resumedFromWorkItemId: resumedFrom.workItemId } : {}),
  });

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
    ...(resumedFrom ? { resumedFrom: resumedFrom.workItemId } : {}),
  });
  console.log(
    JSON.stringify({
      message: 'session prepared',
      workItemId: workItem.id,
      branch,
      baseBranch,
      rework: rework !== undefined,
      resumedFrom: resumedFrom?.workItemId,
      attempt,
    }),
  );

  return {
    workItem,
    sessionId: workItem.id,
    branch,
    baseBranch,
    baseCommit,
    factorialVersion: input.factorialVersion,
    attempt,
    artefactPrefix: prefix,
  };
};
