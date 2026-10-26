/**
 * Prepare: accept the WorkItem exactly once, then set up the builder's session
 * deterministically: clone the repository, put the session on the work branch
 * (a fresh branch off the default head, or the existing rework branch), and
 * leave the WorkItem on disk for the agent to read, with the request copied to
 * the top of /workspace/notes.md so it stays in view. When an earlier attempt
 * at the same source failed but saved its work, the session resumes on that
 * attempt's branch instead of starting afresh. For rework items, the
 * review details — including the failing checks' logs, fetched here with a
 * short-lived read-only token and redacted — are left at /workspace/rework.md.
 * No model is involved. The builder plans in this session with its plan
 * subagent, so no plan is written here; a later round (ContinueBuild) and the
 * reviewer's session are set up the same way, by `seedSession`.
 *
 * The session is brand new at this point, so no agent code can be running.
 * The read-only token is sent as an HTTP header for the clone only and is not
 * written anywhere in the session.
 */
import { artefactPrefix, putJsonArtefact, redactSecrets } from '@factorial/artefacts';
import type { CheckJob, GitHubClient, PullRequestState, Repo } from '@factorial/github-app';
import { assertWorkItem, type ReworkContext, type WorkItem, type WorkItemReviewDetail } from '@factorial/workitem';

import { reworkContext, workBranchFor, type WorkContext } from '../lib/context.ts';
import { logged, unvalidatedId, type Logger, type RunKey } from '../lib/log.ts';
import { nextAttempt, resumableAttempt, type Attempt } from '../lib/resume.ts';
import { botLogin, repositoryClient, repositoryToken } from '../lib/github.ts';
import { REFUSED_STATUSES, acceptedBefore, admitRework, commentToAcknowledge, inlineCommentIdFromUrl, pointOrigins, pullRequestMismatch, reviewIdFromUrl, reworkPoints, type EarlierItem } from '../lib/rework-admission.ts';
import { handOverWorkspace, mustRun, sessionTarget, type SessionRole } from '../lib/session.ts';
import {
  HARDENED_GIT_ENV,
  assertCommitSha,
  assertGitHubName,
  assertGitBranch,
  assertUuid,
  gitAuthHeader,
  shellQuote,
} from '../lib/shell.ts';
import { TooManyItemsError, acceptWorkItem, attemptRecord, attemptsAtSource, itemsAtSource, openerOf, recordProgress, reworkCauseOf } from '../lib/table.ts';

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
  /**
   * The commit the session must start from, when another session has already
   * fixed it: a new branch is created there, and an existing branch must still
   * be there.
   */
  at?: string;
}): string {
  const owner = assertGitHubName(params.owner, 'repository owner');
  const name = assertGitHubName(params.name, 'repository name');
  const branch = assertGitBranch(params.branch, 'work branch');
  const url = `https://github.com/${owner}/${name}.git`;
  const workItemBase64 = Buffer.from(params.workItemJson, 'utf8').toString('base64');
  const notesBase64 = Buffer.from(params.notes, 'utf8').toString('base64');
  const at = params.at === undefined ? undefined : assertCommitSha(params.at, 'start commit');
  const checkout =
    params.mode === 'create'
      ? `git checkout --quiet -b ${shellQuote(branch)}${at ? ` ${shellQuote(at)}` : ''}`
      : [
          `git checkout --quiet ${shellQuote(`origin/${branch}`)}`,
          `git branch --quiet ${shellQuote(branch)}`,
          ...(at ? [`test "$(git rev-parse HEAD)" = ${shellQuote(at)} || { echo ${shellQuote(`branch ${branch} is not at the expected commit ${at}`)} >&2; exit 1; }`] : []),
        ].join('\n');
  return [
    'set -euo pipefail',
    HARDENED_GIT_ENV,
    'rm -rf /workspace/repo /workspace/summary.md /workspace/workitem.json /workspace/rework.md /workspace/notes.md /workspace/logs /workspace/plan.md /workspace/plan.json /workspace/diff.patch /workspace/review.json',
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
 * own notes. Compaction can summarise older messages, including the prompt,
 * so the notes file is what keeps the task in view for the whole session.
 */
export function initialNotes(
  workItem: WorkItem,
  options: { rework?: boolean; resumedFrom?: Attempt; role?: SessionRole } = {},
): string {
  const planSection =
    options.role === 'reviewer'
      ? '_The plan the builder followed is /workspace/plan.json, with its explanation in /workspace/plan.md. Your review goes in /workspace/review.json, not here. Keep working notes under # Notes._'
      : '_Your plan, from the plan subagent, goes in /workspace/plan.json and /workspace/plan.md: follow its steps in order by `id`. Keep a line here per step (done, part done, not started), and note any step you change or skip, and why._';
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
    ...(options.rework ? ['', 'This is rework: every numbered point in /workspace/rework.md must be addressed, and answered by its number under `## Rework points` in summary.md.'] : []),
    ...(options.resumedFrom ? ['', ...previousAttemptSection(options.resumedFrom)] : []),
    '',
    '# Plan',
    '',
    planSection,
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

const REWORK_CAUSES: Record<ReworkContext['cause'], string> = {
  review: 'review comments',
  'checks-failed': 'failed checks',
  comment: "a request made in the pull request's conversation",
};

/**
 * `/workspace/rework.md`: the points to address, plus — when the cause is
 * failed checks — the failing jobs and the tail of each of their logs. When
 * the item came from a review (its source URL names one), the review's
 * inline comments follow the work item's own details as further points:
 * they are not in the webhook. Every session seeded for the item builds the
 * same file, so the numbering holds across rounds and for the reviewer.
 * Everything comes from untrusted text and is redacted before it is written
 * into the session.
 */
export async function buildReworkFile(
  client: GitHubClient,
  repo: { owner: string; name: string },
  headSha: string,
  rework: ReworkContext,
  options: { sourceUrl?: string; previousWorkItemId?: string } = {},
): Promise<{ text: string; points: WorkItemReviewDetail[] }> {
  const reviewId = rework.cause === 'review' ? reviewIdFromUrl(options.sourceUrl ?? '') : undefined;
  const points = reworkPoints(rework.details, reviewId === undefined ? [] : await client.listReviewComments(repo, rework.pullRequest.number, reviewId));
  const lines: string[] = [
    `# Rework of pull request #${rework.pullRequest.number}`,
    '',
    `Previous work item: ${options.previousWorkItemId ?? rework.previousWorkItemId}`,
    `Pull request: ${rework.pullRequest.url}`,
    `Cause: ${REWORK_CAUSES[rework.cause]}`,
    '',
    '## Points to address',
    '',
  ];
  if (points.length === 0) {
    lines.push('_No specific points were recorded; see the pull request._');
  }
  points.forEach((detail, i) => lines.push(...detailSection(detail, i + 1)));
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
  return { text: `${lines.join('\n')}\n`, points };
}

/**
 * One point, numbered from 1 in the order the work item lists them: the
 * builder answers each by its number under `## Rework points` in summary.md,
 * and the orchestrator pairs the answers with the points in its reply.
 */
function detailSection(detail: WorkItemReviewDetail, n: number): string[] {
  const where = detail.path
    ? ` (${detail.path}${detail.line === undefined ? '' : `:${detail.line}`})`
    : '';
  return [`### Point ${n}: @${detail.author}${where}`, '', redactSecrets(detail.body.trim()), ''];
}

/**
 * The earlier attempt to resume, if any, and only while its branch still
 * exists. Any failure to tell (a lookup error, a deleted branch) starts the
 * item afresh, as before.
 */
async function resumable(repo: { owner: string; name: string }, workItem: WorkItem, log: Logger): Promise<Attempt | undefined> {
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
    log.info('not resuming', { error });
    return undefined;
  }
}

/**
 * Clone the repository into one role's session and leave the WorkItem, the
 * notes and, for rework, /workspace/rework.md beside it. The first session
 * fixes the branch head; a later one passes it as `at`, so every role works
 * from the same commit. Returns that commit and the base branch.
 */
export async function seedSession(params: {
  role: SessionRole;
  workItem: WorkItem;
  branch: string;
  resumedFrom?: Attempt;
  at?: string;
  /** Check out the branch as it is on the remote, even for a new item: the reviewer's case, after the push. */
  existing?: boolean;
  /** The session to seed; the work item id unless the build is in a later round. */
  sessionId?: string;
  /** For rework, the pull request's actual base, which Prepare read from GitHub. */
  baseBranch?: string;
  /** For rework, the item that opened the pull request, from the ledger. */
  previousWorkItemId?: string;
}): Promise<{ baseCommit: string; baseBranch: string; reworkPoints?: WorkItemReviewDetail[] }> {
  const { workItem, branch, resumedFrom } = params;
  const repo = { owner: workItem.repository.owner, name: workItem.repository.name };
  const rework = reworkContext(workItem);
  const token = await repositoryToken(repo, { contents: 'read' });
  const target = sessionTarget(params.sessionId ?? workItem.id, params.role);
  const result = await mustRun(
    target,
    cloneScript({
      owner: repo.owner,
      name: repo.name,
      branch,
      token,
      workItemJson: JSON.stringify(workItem, null, 2),
      notes: initialNotes(workItem, { rework: rework !== undefined, role: params.role, ...(resumedFrom ? { resumedFrom } : {}) }),
      mode: rework || resumedFrom || params.existing ? 'checkout' : 'create',
      ...(params.at ? { at: params.at } : {}),
    }),
    600,
  );
  const stdoutLines = result.stdout.trim().split('\n');
  const baseCommit = assertCommitSha(stdoutLines[stdoutLines.length - 2] ?? '', 'branch head');
  const baseBranch = rework ? params.baseBranch ?? rework.baseBranch : stdoutLines[stdoutLines.length - 1] ?? 'main';

  if (rework) {
    const client = await repositoryClient(repo, { contents: 'read', actions: 'read', pull_requests: 'read' });
    const reworkFile = await buildReworkFile(client, repo, baseCommit, rework, {
      sourceUrl: workItem.source.url,
      ...(params.previousWorkItemId ? { previousWorkItemId: params.previousWorkItemId } : {}),
    });
    const encoded = Buffer.from(reworkFile.text, 'utf8').toString('base64');
    await mustRun(
      target,
      [`set -euo pipefail`, `printf '%s' ${shellQuote(encoded)} | base64 -d > /workspace/rework.md`].join('\n'),
      60,
    );
    return { baseCommit, baseBranch, reworkPoints: reworkFile.points };
  }
  return { baseCommit, baseBranch };
}

export class ReworkNotAdmittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReworkNotAdmitted';
  }
}

/**
 * Check that a rework item may run (`lib/rework-admission.ts`). A refusal is
 * recorded on the ledger and in `report.json`, answered on the pull request
 * when a person asked, and ends the execution through ReworkNotAdmitted.
 * Returns the pull request as GitHub reports it, and the item that opened
 * it: the ledger's record, which the branch name only approximates.
 */
async function admitReworkItem(
  workItem: WorkItem,
  rework: ReworkContext,
  createdAt: string,
  prefix: string,
  log: Logger,
): Promise<{ pr: PullRequestState; openedBy: string }> {
  const repo = { owner: workItem.repository.owner, name: workItem.repository.name };
  const refuse = async (status: string, reason: string, reply?: string): Promise<never> => {
    if (reply) {
      try {
        const client = await repositoryClient(repo, { issues: 'write', pull_requests: 'write' });
        await client.commentOnIssue(repo, rework.pullRequest.number, reply);
      } catch (error) {
        log.error('refusal not posted on the pull request', { error });
      }
    }
    await recordProgress(workItem.id, status, { refusedReason: reason, reworkOf: { previousWorkItemId: rework.previousWorkItemId, prNumber: rework.pullRequest.number } });
    await putJsonArtefact(prefix, 'report.json', { outcome: status, reason });
    log.info('rework not admitted', { status, reason, replied: reply !== undefined });
    throw new ReworkNotAdmittedError(reason);
  };

  const client = await repositoryClient(repo, { pull_requests: 'read' });
  const pr = await client.getPullRequest(repo, rework.pullRequest.number);
  const mismatch = pullRequestMismatch(pr, rework, await botLogin());
  if (mismatch) return refuse('not-eligible', mismatch);
  const opener = await openerOf(repo, pr.number);
  if (!opener) return refuse('not-eligible', `Factorial has no record of opening pull request #${pr.number}`);
  if (opener.branch !== rework.branch) return refuse('not-eligible', `the item that opened pull request #${pr.number} worked on ${opener.branch ?? 'no branch'}, not ${rework.branch}`);

  // An inline comment addressed to Factorial inside a review that requests
  // changes also arrives as that review, whose item takes all its comments.
  // Whichever item came first, only the review's may run.
  const commentId = inlineCommentIdFromUrl(workItem.source.url);
  if (commentId !== undefined && (await client.reviewStateOfComment(repo, pr.number, commentId)) === 'CHANGES_REQUESTED') {
    return refuse('covered-by-review', 'the comment belongs to a review requesting changes, which is reworked as a whole');
  }

  let earlier: EarlierItem[];
  try {
    earlier = await itemsAtSource(workItem);
  } catch (error) {
    if (error instanceof TooManyItemsError) return refuse('busy', error.message);
    throw error;
  }
  if (rework.cause === 'checks-failed') {
    // Only the causes the limit walks: newest first, up to the first item
    // a person asked for, refused items read too so they can be skipped.
    const current = { workItemId: workItem.id, createdAt };
    for (const item of earlier) {
      if (item.workItemId === workItem.id || !acceptedBefore(item, current)) continue;
      const cause = await reworkCauseOf(item.workItemId);
      if (cause !== undefined) item.cause = cause;
      if (cause !== 'checks-failed' && !REFUSED_STATUSES.has(item.status ?? '')) break;
    }
  }
  const admission = admitRework({ workItemId: workItem.id, createdAt, cause: rework.cause }, earlier, new Date());
  if (!admission.ok) return refuse(admission.status, admission.reason, admission.reply);
  await acknowledge(repo, workItem, log);
  return { pr, openedBy: opener.workItemId };
}

/**
 * React to the comment that asked for the work (eyes), so the person sees
 * at once that it was taken; the reply comes when the rework finishes. A
 * review has no reaction API, and a failed run no comment. Never fatal.
 */
async function acknowledge(repo: Repo, workItem: WorkItem, log: Logger): Promise<void> {
  const target = commentToAcknowledge(workItem.source.url);
  if (!target) return;
  try {
    const client = await repositoryClient(repo, { issues: 'write', pull_requests: 'write' });
    await client.addReaction(repo, target, 'eyes');
  } catch (error) {
    log.error('comment not acknowledged', { error });
  }
}

const prepareKey = (input: PrepareInput): RunKey => ({ workItemId: unvalidatedId(input.workItem) });

export const handler = logged('prepare', prepareKey, async (input, stageLog): Promise<WorkContext> => {
  assertWorkItem(input.workItem);
  const workItem = input.workItem;
  assertUuid(workItem.id, 'WorkItem id');

  const repo = { owner: workItem.repository.owner, name: workItem.repository.name };
  const rework = reworkContext(workItem);
  // Looked up before accepting, so the row is written with its attempt
  // number. The lookup only reads, so a duplicate delivery changes nothing.
  const resumedFrom = rework ? undefined : await resumable(repo, workItem, stageLog);
  const attempt = nextAttempt(resumedFrom);
  const log = stageLog.with({ attempt });
  const prefix = artefactPrefix(workItem.id, attempt);

  const createdAt = await acceptWorkItem(workItem, input.factorialVersion, attempt);
  await putJsonArtefact(prefix, 'workitem.json', workItem);
  const admitted = rework ? await admitReworkItem(workItem, rework, createdAt, prefix, log) : undefined;

  const branch = resumedFrom?.branch ?? workBranchFor(workItem);
  const { baseCommit, baseBranch, reworkPoints: points } = await seedSession({
    role: 'builder',
    workItem,
    branch,
    ...(resumedFrom ? { resumedFrom } : {}),
    ...(admitted ? { baseBranch: admitted.pr.baseRef, previousWorkItemId: admitted.openedBy } : {}),
  });
  await handOverWorkspace(sessionTarget(workItem.id, 'builder'));

  await putJsonArtefact(prefix, 'prepare/branch.json', {
    branch,
    baseSha: baseCommit,
    factorialVersion: input.factorialVersion,
    ...(resumedFrom ? { resumedFromWorkItemId: resumedFrom.workItemId } : {}),
  });

  await recordProgress(workItem.id, 'prepared', {
    branch,
    baseBranch,
    sessionId: workItem.id,
    ...(rework ? { reworkOf: { previousWorkItemId: admitted?.openedBy ?? rework.previousWorkItemId, prNumber: rework.pullRequest.number } } : {}),
    ...(resumedFrom ? { resumedFrom: resumedFrom.workItemId } : {}),
  });
  log.info('session prepared', { branch, baseBranch, rework: rework !== undefined, resumedFrom: resumedFrom?.workItemId });

  return {
    workItem,
    sessionId: workItem.id,
    branch,
    baseBranch,
    baseCommit,
    factorialVersion: input.factorialVersion,
    attempt,
    artefactPrefix: prefix,
    ...(resumedFrom ? { resumedFrom } : {}),
    ...(points ? { reworkPoints: pointOrigins(points) } : {}),
    ...(admitted ? { previousWorkItemId: admitted.openedBy } : {}),
  };
});
