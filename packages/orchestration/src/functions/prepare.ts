/**
 * Prepare: set up the builder's session deterministically for an item Intake
 * admitted: seed the repository, put the session on the thread's branch (a
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
 * The repository reaches it as a git bundle this function fetched with a
 * short-lived read-only token (`lib/repo-seed.ts`): the session never
 * contacts GitHub and no token enters it.
 */
import { putJsonArtefact } from '@factorial/artefacts';
import type { GitHubClient } from '@factorial/github-app';
import type { RuntimeName } from '@factorial/roles';
import { assertWorkItem, type WorkItem, type WorkItemReviewDetail } from '@factorial/workitem';

import type { ReworkTurn, WorkContext } from '../lib/context.ts';
import { unvalidatedId, type RunKey } from '../lib/log.ts';
import { staged, type ProgressInput } from '../lib/progress.ts';
import type { Attempt } from '../lib/resume.ts';
import { repositoryClient } from '../lib/github.ts';
import { seedRepository, type SeedRepositoryDeps } from '../lib/repo-seed.ts';
import { pointOrigins } from '../lib/rework-points.ts';
import { assembleSeed, writeSeed, type Seed, type SeedContext, type SeedProvider } from '../lib/seed.ts';
import { notesProvider, requestProvider, reworkProvider } from '../lib/seed-providers.ts';
import { handOverWorkspace, sessionTarget, type SessionRole, type SessionTarget } from '../lib/session.ts';
import { assertGitBranch, assertUuid } from '../lib/shell.ts';
import { transferKey } from '../lib/transfer.ts';
import { recordProgress } from '../lib/table.ts';

import type { IntakeResult } from './intake.ts';

interface PrepareInput extends ProgressInput {
  workItem: unknown;
  factorialVersion: string;
  /** Intake's result; the state machine reaches Prepare only for the change route. */
  intake: IntakeResult;
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
  /** The run's `<workItemId>/<attempt>/`, and the stage's directory under it, for the transfer key of the repository bundle. */
  artefactPrefix: string;
  stage: string;
}

/** What a stage supplies to its providers beyond the item and the checkout. */
/** What seeding the repository alone takes: any Runtime's session, the verifier's too, which gets no seed files. */
export interface CheckoutParams extends Omit<SessionParams, 'role'> {
  role: RuntimeName;
}

export type SeedExtras = Partial<Pick<SeedContext, 'round' | 'continuing' | 'previousNotes' | 'plan' | 'summary' | 'sensitive'>>;

export interface SeededCheckout {
  target: SessionTarget;
  baseCommit: string;
  baseBranch: string;
}

/**
 * Seed the repository into one role's session and put it on the branch
 * (`lib/repo-seed.ts`: fetched and bundled here, fetched from the bundle in
 * the session, which never reaches GitHub). The first session fixes the
 * branch head; a later one passes it as `at`, so every role works from the
 * same commit. Nothing is placed in /workspace beside the repository: that is
 * `placeSeed`.
 */
export async function seedCheckout(params: CheckoutParams, deps?: SeedRepositoryDeps): Promise<SeededCheckout> {
  const { workItem, branch, resumedFrom, rework } = params;
  const target = sessionTarget(params.sessionId ?? workItem.id, params.role);
  const { head, defaultBranch } = await seedRepository(
    {
      target,
      repository: { owner: workItem.repository.owner, name: workItem.repository.name },
      transferKey: transferKey(params.artefactPrefix, params.stage, 'repo.bundle'),
      branch,
      mode: rework || resumedFrom || params.existing ? 'checkout' : 'create',
      ...(params.at ? { at: params.at } : {}),
      ...(rework ? { baseBranch: rework.baseBranch } : {}),
    },
    deps,
  );
  return { target, baseCommit: head, baseBranch: rework ? rework.baseBranch : defaultBranch };
}

/**
 * Assemble the session's seed from the stage's providers, in order, and place
 * its files in the session with the one writer. Call it after the checkout and
 * before `handOverWorkspace`. Returns the seed, for its sections and data.
 */
export async function placeSeed(seeded: SeededCheckout, params: SessionParams, providers: readonly SeedProvider[], extras: SeedExtras = {}): Promise<Seed> {
  const { workItem, resumedFrom, rework } = params;
  const repo = { owner: workItem.repository.owner, name: workItem.repository.name };
  let client: Promise<GitHubClient> | undefined;
  const seed = await assembleSeed(providers, {
    role: params.role,
    workItem,
    baseCommit: seeded.baseCommit,
    baseBranch: seeded.baseBranch,
    round: 1,
    ...(resumedFrom ? { resumedFrom } : {}),
    ...(rework ? { rework } : {}),
    ...extras,
    github: () => (client ??= repositoryClient(repo, { contents: 'read', actions: 'read', pull_requests: 'read' })),
  });
  await writeSeed(seeded.target, seed);
  return seed;
}

/** Seed the repository into one role's session and place its files: the two steps `seedCheckout` and `placeSeed`, when the stage needs nothing between them. */
export async function seedSession(
  params: SessionParams & { providers: readonly SeedProvider[]; extras?: SeedExtras },
): Promise<{ baseCommit: string; baseBranch: string; reworkPoints?: WorkItemReviewDetail[] }> {
  const seeded = await seedCheckout(params);
  const seed = await placeSeed(seeded, params, params.providers, params.extras);
  const { baseCommit, baseBranch } = seeded;
  return { baseCommit, baseBranch, ...(seed.data.reworkPoints ? { reworkPoints: seed.data.reworkPoints } : {}) };
}

/** What a new session for a change is seeded with, in this order: the numbering of a rework's points depends on it. */
export const PREPARE_PROVIDERS: readonly SeedProvider[] = [requestProvider, notesProvider, reworkProvider];

const prepareKey = (input: PrepareInput): RunKey => ({ workItemId: unvalidatedId(input.workItem) });

export const handler = staged('prepare', prepareKey, {}, async (input, stageLog): Promise<WorkContext> => {
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
    artefactPrefix: prefix,
    stage: 'prepare',
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
