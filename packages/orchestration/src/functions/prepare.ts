/**
 * Prepare: set up the builder's session deterministically for an item Intake
 * admitted: clone the repository, put the session on the thread's branch (a
 * fresh branch off the default head, or the existing branch of a resumed
 * attempt or a pull request), and leave the WorkItem on disk for the agent to
 * read, with the request copied to the top of /workspace/notes.md so it stays
 * in view. For a turn on a pull request, the points to address, including
 * the failing checks' logs, fetched with a short-lived read-only token
 * and redacted, are left at /workspace/rework.md. These files are the seed,
 * assembled from the providers listed below (`lib/seed.ts`).
 * No model is involved. The builder plans in this session with its plan
 * subagent, so no plan is written here; a later round (ContinueBuild) and the
 * reviewer's session are seeded the same way, from their own lists of providers.
 *
 * The session is brand new at this point, so no agent code can be running.
 * The read-only token is sent as an HTTP header for the clone only and is not
 * written anywhere in the session.
 */
import { putJsonArtefact } from '@factorial/artefacts';
import type { GitHubClient } from '@factorial/github-app';
import { assertWorkItem, type WorkItem, type WorkItemReviewDetail } from '@factorial/workitem';

import type { ReworkTurn, WorkContext } from '../lib/context.ts';
import { logged, unvalidatedId, type RunKey } from '../lib/log.ts';
import type { Attempt } from '../lib/resume.ts';
import { repositoryClient, repositoryToken } from '../lib/github.ts';
import { pointOrigins } from '../lib/rework-points.ts';
import { assembleSeed, writeSeed, type Seed, type SeedContext, type SeedProvider } from '../lib/seed.ts';
import { notesProvider, requestProvider, reworkProvider } from '../lib/seed-providers.ts';
import { handOverWorkspace, mustRun, sessionTarget, type SessionRole, type SessionTarget } from '../lib/session.ts';
import {
  HARDENED_GIT_ENV,
  assertCommitSha,
  assertGitHubName,
  assertGitBranch,
  assertUuid,
  gitAuthHeader,
  shellQuote,
} from '../lib/shell.ts';
import { recordProgress } from '../lib/table.ts';

import type { IntakeResult } from './intake.ts';

interface PrepareInput {
  workItem: unknown;
  factorialVersion: string;
  /** Intake's result; the state machine reaches Prepare only for the change route. */
  intake: IntakeResult;
}

/**
 * Clone the repository and put the session on the branch; print the head
 * commit and the base branch. It clears the session's files but writes none:
 * those are the seed's (`lib/seed.ts`).
 */
export function cloneScript(params: {
  owner: string;
  name: string;
  branch: string;
  token: string;
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
    `git symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##'`,
  ].join('\n');
}

/** What seeding a session takes from the stage. */
export interface SessionParams {
  role: SessionRole;
  workItem: WorkItem;
  branch: string;
  resumedFrom?: Attempt;
  at?: string;
  /** Check out the branch as it is on the remote, even for a new item: the reviewer's case, after the push. */
  existing?: boolean;
  /** The session to seed; the work item id unless the build is in a later round. */
  sessionId?: string;
  /** For a turn on a pull request, as Intake established it. */
  rework?: ReworkTurn;
}

/** What a stage supplies to its providers beyond the item and the clone. */
export type SeedExtras = Partial<Pick<SeedContext, 'round' | 'continuing' | 'previousNotes' | 'plan' | 'summary' | 'sensitive'>>;

export interface ClonedSession {
  target: SessionTarget;
  baseCommit: string;
  baseBranch: string;
}

/**
 * Clone the repository into one role's session and put it on the branch. The
 * first session fixes the branch head; a later one passes it as `at`, so
 * every role works from the same commit. Nothing is placed in /workspace
 * beside the clone: that is `placeSeed`.
 */
export async function cloneSession(params: SessionParams): Promise<ClonedSession> {
  const { workItem, branch, resumedFrom, rework } = params;
  const repo = { owner: workItem.repository.owner, name: workItem.repository.name };
  const token = await repositoryToken(repo, { contents: 'read' });
  const target = sessionTarget(params.sessionId ?? workItem.id, params.role);
  const result = await mustRun(
    target,
    cloneScript({
      owner: repo.owner,
      name: repo.name,
      branch,
      token,
      mode: rework || resumedFrom || params.existing ? 'checkout' : 'create',
      ...(params.at ? { at: params.at } : {}),
    }),
    600,
  );
  const stdoutLines = result.stdout.trim().split('\n');
  const baseCommit = assertCommitSha(stdoutLines[stdoutLines.length - 2] ?? '', 'branch head');
  const baseBranch = rework ? rework.baseBranch : stdoutLines[stdoutLines.length - 1] ?? 'main';
  return { target, baseCommit, baseBranch };
}

/**
 * Assemble the session's seed from the stage's providers, in order, and place
 * its files in the session with the one writer. Call it after the clone and
 * before `handOverWorkspace`. Returns the seed, for its sections and data.
 */
export async function placeSeed(cloned: ClonedSession, params: SessionParams, providers: readonly SeedProvider[], extras: SeedExtras = {}): Promise<Seed> {
  const { workItem, resumedFrom, rework } = params;
  const repo = { owner: workItem.repository.owner, name: workItem.repository.name };
  let client: Promise<GitHubClient> | undefined;
  const seed = await assembleSeed(providers, {
    role: params.role,
    workItem,
    baseCommit: cloned.baseCommit,
    baseBranch: cloned.baseBranch,
    round: 1,
    ...(resumedFrom ? { resumedFrom } : {}),
    ...(rework ? { rework } : {}),
    ...extras,
    github: () => (client ??= repositoryClient(repo, { contents: 'read', actions: 'read', pull_requests: 'read' })),
  });
  await writeSeed(cloned.target, seed);
  return seed;
}

/** Clone the repository into one role's session and seed it: the two steps `cloneSession` and `placeSeed`, when the stage needs nothing between them. */
export async function seedSession(
  params: SessionParams & { providers: readonly SeedProvider[]; extras?: SeedExtras },
): Promise<{ baseCommit: string; baseBranch: string; reworkPoints?: WorkItemReviewDetail[] }> {
  const cloned = await cloneSession(params);
  const seed = await placeSeed(cloned, params, params.providers, params.extras);
  const { baseCommit, baseBranch } = cloned;
  return { baseCommit, baseBranch, ...(seed.data.reworkPoints ? { reworkPoints: seed.data.reworkPoints } : {}) };
}

/** What a new session for a change is seeded with, in this order: the numbering of a rework's points depends on it. */
export const PREPARE_PROVIDERS: readonly SeedProvider[] = [requestProvider, notesProvider, reworkProvider];

const prepareKey = (input: PrepareInput): RunKey => ({ workItemId: unvalidatedId(input.workItem) });

export const handler = logged('prepare', prepareKey, async (input, stageLog): Promise<WorkContext> => {
  assertWorkItem(input.workItem);
  const workItem = input.workItem;
  assertUuid(workItem.id, 'WorkItem id');
  const { intake } = input;
  if (intake.route !== 'change') throw new Error(`Prepare reached for route ${intake.route}`);
  const { attempt, artefactPrefix: prefix, resumedFrom, rework } = intake;
  const log = stageLog.with({ attempt });

  const branch = assertGitBranch(intake.branch, 'work branch');
  const { baseCommit, baseBranch, reworkPoints: points } = await seedSession({
    providers: PREPARE_PROVIDERS,
    role: 'builder',
    workItem,
    branch,
    ...(resumedFrom ? { resumedFrom } : {}),
    ...(rework ? { rework } : {}),
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
    ...(rework ? { reworkOf: { previousWorkItemId: rework.previousWorkItemId, prNumber: rework.pullRequest.number } } : {}),
    ...(resumedFrom ? { resumedFrom: resumedFrom.workItemId } : {}),
  });
  log.info('session prepared', { branch, baseBranch, threadKey: intake.threadKey, rework: rework !== undefined, resumedFrom: resumedFrom?.workItemId });

  return {
    workItem,
    threadKey: intake.threadKey,
    sessionId: workItem.id,
    branch,
    baseBranch,
    baseCommit,
    factorialVersion: input.factorialVersion,
    attempt,
    artefactPrefix: prefix,
    ...(resumedFrom ? { resumedFrom } : {}),
    ...(points ? { reworkPoints: pointOrigins(points) } : {}),
    ...(rework ? { rework } : {}),
  };
});
