/**
 * The providers a session's seed is assembled from (#166), one per kind of
 * context. Each is a function from the seeding context to files and
 * first-message sections (`lib/seed.ts`); a stage lists the ones it wants,
 * in order, in its handler. Every file's content is built here from what the
 * orchestrator holds, redacted where it comes from untrusted text, so the
 * same item gives the same files in every session that is seeded for it.
 */
import { redactSecrets } from '@factorial/artefacts';
import type { CheckJob, GitHubClient, Repo } from '@factorial/github-app';
import { ROLES } from '@factorial/roles';
import { TRIGGER_TYPES, type WorkItem, type WorkItemReviewDetail, type WorkItemReworkCause } from '@factorial/workitem';

import type { ReworkTurn } from './context.ts';
import { continuingSection } from './continue-files.ts';
import type { Attempt } from './resume.ts';
import { MAX_SENSITIVE_JSON_CHARS, sensitivePathsJson } from './review-files.ts';
import { inlineCommentIdFromUrl, reviewIdFromUrl, reworkPoints } from './rework-points.ts';
import type { SeedPart, SeedProvider } from './seed.ts';
import type { SessionRole } from './session.ts';
import { HARDENED_GIT_ENV, assertGitBranch, shellQuote } from './shell.ts';
import { reworkDetails } from './turn.ts';

const KIB = 1024;
/** The WorkItem as JSON. */
export const MAX_REQUEST_BYTES = 256 * KIB;
/** The notes: the request, the agent's own notes (the previous round's are read back at 64 KiB) and what the orchestrator adds. */
export const MAX_NOTES_BYTES = 256 * KIB;
/** The points and the failing jobs' log tails. */
export const MAX_REWORK_BYTES = 256 * KIB;
/** The plan files are read back from the artefact store at most this large. */
export const MAX_PLAN_BYTES = 64 * KIB;
/** The builder's summary, which Collect reads at most 60000 bytes of. */
export const MAX_SUMMARY_BYTES = 64 * KIB;
/** The diff, as large as Collect exports. */
export const MAX_DIFF_BYTES = 5 * 1024 * KIB;
/** A repository's instructions. */
export const MAX_INSTRUCTIONS_BYTES = 32 * KIB;
/** The repository's instructions file, on the base branch. */
export const INSTRUCTIONS_FILE = '.factorial/instructions.md';

/**
 * The starting /workspace/notes.md: the request itself, ahead of the agent's
 * own notes. Compaction can summarise older messages, including the prompt,
 * so the notes file is what keeps the task in view for the whole session.
 */
export function initialNotes(
  workItem: WorkItem,
  options: { rework?: boolean; resumedFrom?: Attempt; role?: SessionRole } = {},
): string {
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
    ROLES[options.role ?? 'builder'].notesPlan,
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

const REWORK_CAUSES: Record<WorkItemReworkCause, string> = {
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
  rework: Pick<ReworkTurn, 'pullRequest' | 'cause' | 'previousWorkItemId'>,
  details: readonly WorkItemReviewDetail[],
  options: { sourceUrl?: string } = {},
): Promise<{ text: string; points: WorkItemReviewDetail[] }> {
  const reviewId = rework.cause === 'review' ? reviewIdFromUrl(options.sourceUrl ?? '') : undefined;
  const points = reworkPoints(details, reviewId === undefined ? [] : await client.listReviewComments(repo, rework.pullRequest.number, reviewId));
  const lines: string[] = [
    `# Rework of pull request #${rework.pullRequest.number}`,
    '',
    `Previous work item: ${rework.previousWorkItemId}`,
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
 * The points an item carries, with an inline comment's file and line, which
 * an item that names only the comment does not hold (#163): fetched here.
 */
export async function detailsFor(client: Pick<GitHubClient, 'getReviewComment'>, repo: Repo, workItem: WorkItem): Promise<WorkItemReviewDetail[]> {
  const details = reworkDetails(workItem);
  if (workItem.inReplyTo === undefined || workItem.source.type !== TRIGGER_TYPES.githubPullRequestReviewComment) return details;
  const id = inlineCommentIdFromUrl(workItem.source.url);
  if (id === undefined) return details;
  const comment = await client.getReviewComment(repo, id);
  return details.map((d) => ({ ...d, path: comment.path, ...(comment.line && comment.line > 0 ? { line: comment.line } : {}) }));
}


/** The request: the WorkItem, as the agent reads it from /workspace/workitem.json. */
export const requestProvider: SeedProvider = (context): SeedPart => ({
  files: [{ path: 'workitem.json', content: JSON.stringify(context.workItem, null, 2), cap: MAX_REQUEST_BYTES }],
});

/**
 * The starting notes: the request ahead of the agent's own notes, and for a
 * resumed item the earlier attempt.
 */
export const notesProvider: SeedProvider = (context): SeedPart => ({
  files: [
    {
      path: 'notes.md',
      content: initialNotes(context.workItem, {
        rework: context.rework !== undefined,
        role: context.role,
        ...(context.resumedFrom ? { resumedFrom: context.resumedFrom } : {}),
      }),
      cap: MAX_NOTES_BYTES,
      truncate: true,
    },
  ],
});

/**
 * A continuation's notes: the previous round's, which the builder kept as its
 * memory, or the starting notes when they were lost, then the section that
 * says where the round stands.
 */
export const roundNotesProvider: SeedProvider = (context): SeedPart => {
  const { continuing } = context;
  if (continuing === undefined) throw new Error('a continuation needs to know what the previous round left');
  const notes =
    context.previousNotes ?? initialNotes(context.workItem, { role: context.role, ...(context.resumedFrom ? { resumedFrom: context.resumedFrom } : {}) });
  const section = continuingSection({
    round: context.round,
    baseCommit: continuing.baseCommit,
    pushed: continuing.pushed,
    commitCount: continuing.commitCount,
    planned: context.plan !== undefined,
  });
  return { files: [{ path: 'notes.md', content: notes + section, cap: MAX_NOTES_BYTES, truncate: true }] };
};

/** For a turn on a pull request, the points to address and, after failed checks, the failing jobs' logs. */
export const reworkProvider: SeedProvider = async (context): Promise<SeedPart> => {
  const { rework, workItem } = context;
  if (rework === undefined) return {};
  const repo = { owner: workItem.repository.owner, name: workItem.repository.name };
  const client = await context.github();
  const file = await buildReworkFile(client, repo, context.baseCommit, rework, await detailsFor(client, repo, workItem), { sourceUrl: workItem.source.url });
  return {
    files: [{ path: 'rework.md', content: file.text, cap: MAX_REWORK_BYTES, truncate: true }],
    data: { reworkPoints: file.points },
  };
};

/** The stored plan, when there is one. */
export const planProvider: SeedProvider = (context): SeedPart => {
  if (context.plan === undefined) return {};
  return {
    files: [
      { path: 'plan.json', content: context.plan.json, cap: MAX_PLAN_BYTES },
      { path: 'plan.md', content: context.plan.markdown, cap: MAX_PLAN_BYTES, truncate: true },
    ],
  };
};

/** The builder's account of its work. */
export const summaryProvider: SeedProvider = (context): SeedPart => {
  if (context.summary === undefined) return {};
  return { files: [{ path: 'summary.md', content: context.summary, cap: MAX_SUMMARY_BYTES, truncate: true }] };
};

/**
 * The change itself, made in the session from the clone: three-dot, against
 * the base branch's merge base, so it shows what the pull request would
 * change even when the branch started from an earlier attempt.
 */
export const diffProvider: SeedProvider = (context): SeedPart => {
  const range = shellQuote(`origin/${assertGitBranch(context.baseBranch, 'base branch')}...HEAD`);
  return { files: [{ path: 'diff.patch', command: `git diff --no-color --no-ext-diff --no-textconv --text ${range}`, cap: MAX_DIFF_BYTES }] };
};

/** The paths the reviewer is told to look at with particular care, for its prompt. */
export const sensitivePathsProvider: SeedProvider = (context): SeedPart => {
  if (context.sensitive === undefined) return {};
  return { sections: [{ id: SENSITIVE_PATHS_SECTION, text: sensitivePathsJson(context.sensitive), cap: MAX_SENSITIVE_JSON_CHARS }] };
};

/** The id of the section holding the sensitive paths as JSON, which the invoker takes as SENSITIVE_PATHS. */
export const SENSITIVE_PATHS_SECTION = 'sensitive-paths';

/**
 * The repository's own instructions, from `.factorial/instructions.md` on
 * the target's base branch, never the branch under work: a change cannot
 * write the instructions it is judged by. The notes point to the file, but
 * only when it exists, and not again in a continuation, whose carried-over
 * notes already do.
 */
export const instructionsProvider: SeedProvider = async (context): Promise<SeedPart> => {
  const ref = shellQuote(`origin/${assertGitBranch(context.baseBranch, 'base branch')}:${INSTRUCTIONS_FILE}`);
  const output = await context.read(
    [
      'set -eu',
      HARDENED_GIT_ENV,
      'cd /workspace/repo',
      `if git cat-file -e ${ref} 2>/dev/null; then printf 'ok:'; git show ${ref} | head -c ${MAX_INSTRUCTIONS_BYTES + 1}; else printf 'missing:'; fi`,
    ].join('\n'),
  );
  if (!output.startsWith('ok:')) return {};
  const text = redactSecrets(output.slice('ok:'.length));
  if (text.trim() === '') return {};
  return {
    files: [
      { path: 'instructions.md', content: text, cap: MAX_INSTRUCTIONS_BYTES, truncate: true },
      ...(context.round > 1
        ? []
        : [
            {
              path: 'notes.md',
              content: '\nThe repository has instructions for work on it, read from its base branch: /workspace/instructions.md. Read them before you start.\n',
              cap: MAX_NOTES_BYTES,
              append: true,
            },
          ]),
    ],
  };
};
