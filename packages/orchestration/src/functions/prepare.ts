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
 * A propose turn (#169) is seeded as a new request with /workspace/route.json
 * added, so the host plans and changes nothing. A turn that approves a
 * proposal is seeded with the proposal's stored plan.json, read back from
 * the artefact store and checked against the hash of the plan its comment
 * showed, and a plan.md rendered from it; the builder follows it without
 * planning again, as a later round does.
 *
 * The session is brand new at this point, so no agent code can be running.
 * The repository reaches it as a git bundle this function fetched with a
 * short-lived read-only token (`lib/repo-seed.ts`): the session never
 * contacts GitHub and no token enters it.
 */
import { getTextArtefact, putJsonArtefact, redactSecrets } from '@factorial/artefacts';
import type { GitHubClient } from '@factorial/github-app';
import { assertWorkItem, type WorkItem, type WorkItemReviewDetail } from '@factorial/workitem';

import { parsePlanJson, type Plan } from '@factorial/plan';

import type { Proposal, ReworkTurn, WorkContext } from '../lib/context.ts';
import { unvalidatedId, type RunKey } from '../lib/log.ts';
import { staged, type ProgressInput } from '../lib/progress.ts';
import type { Attempt } from '../lib/resume.ts';
import { repositoryClient } from '../lib/github.ts';
import { seedRepository, type SeedRepositoryDeps } from '../lib/repo-seed.ts';
import { pointOrigins } from '../lib/rework-points.ts';
import { assembleSeed, writeSeed, type Seed, type SeedContext, type SeedProvider } from '../lib/seed.ts';
import { approvedPlanMarkdown, canonicalPlanJson, hasHiddenCharacters, planSha256, planText } from '../lib/proposal-view.ts';
import { MAX_PLAN_ARTEFACT_BYTES } from '../lib/review-files.ts';
import { MAX_REVISION_BYTES, notesProvider, planProvider, requestProvider, revisionProvider, reworkProvider, routeProvider } from '../lib/seed-providers.ts';
import { loadIssueRequest } from '../lib/issue-request.ts';
import { continuedIssue, issueCommand } from '../lib/turn.ts';
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
export type SeedExtras = Partial<Pick<SeedContext, 'round' | 'continuing' | 'previousNotes' | 'plan' | 'summary' | 'sensitive' | 'route' | 'approves' | 'revision'>>;

/**
 * The request for a turn asked for in an issue's conversation (#169): the
 * snapshot of the issue Intake stored when it admitted the turn
 * (`lib/issue-request.ts`), never the issue as it is now. Every session
 * seeded for the item reads it, so the builder, a later round and the
 * reviewer all work from the same request, and not from the comment that
 * asked.
 */
async function requestFor(workItem: WorkItem, artefactPrefix: string): Promise<SeedContext['request']> {
  return continuedIssue(workItem) ? loadIssueRequest(artefactPrefix) : undefined;
}

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
export async function seedCheckout(params: SessionParams, deps?: SeedRepositoryDeps): Promise<SeededCheckout> {
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
  const github = () => (client ??= repositoryClient(repo, { contents: 'read', actions: 'read', pull_requests: 'read' }));
  const request = await requestFor(workItem, params.artefactPrefix);
  const seed = await assembleSeed(providers, {
    role: params.role,
    workItem,
    baseCommit: seeded.baseCommit,
    baseBranch: seeded.baseBranch,
    round: 1,
    ...(resumedFrom ? { resumedFrom } : {}),
    ...(rework ? { rework } : {}),
    ...(request ? { request } : {}),
    ...extras,
    github,
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

/**
 * What a new builder session is seeded with, in this order: the numbering of
 * a rework's points depends on it. The plan is an approved proposal's; the
 * route file is a propose turn's. Each gives nothing otherwise.
 */
export const PREPARE_PROVIDERS: readonly SeedProvider[] = [requestProvider, notesProvider, reworkProvider, planProvider, routeProvider, revisionProvider];

/** The approved proposal's plan cannot be read back as the plan its comment showed: the approval is not built. */
export class ApprovedPlanMismatchError extends Error {
  constructor(proposal: Proposal) {
    super(`the plan proposed by work item ${proposal.workItemId} is not in the artefact store as the valid plan its comment showed`);
    this.name = 'ApprovedPlanMismatch';
  }
}

/**
 * The plan a proposal stored, checked against what was approved: the
 * plan.json its comment showed, by hash, and valid. Anything else is
 * refused rather than built. The build is given the validated plan
 * re-serialised, never the stored text, so it reads exactly the parsed plan
 * that was shown. The planner's plan.md is not given to it either, since
 * the comment may not have shown all of it: plan.md is the orchestrator's
 * rendering of plan.json, the text the approver read.
 */
export function checkApprovedPlan(proposal: Proposal, json: string | undefined): { json: string; markdown: string } {
  const plan = checkProposedPlan(proposal, json);
  return { json: canonicalPlanJson(plan), markdown: approvedPlanMarkdown(plan, proposal.workItemId) };
}

/** The proposal's plan.json, parsed, only if it is the one its comment showed, by hash, valid and free of hidden characters. */
export function checkProposedPlan(proposal: Proposal, json: string | undefined): Plan {
  if (json === undefined || planSha256(json) !== proposal.planSha256) throw new ApprovedPlanMismatchError(proposal);
  const parsed = parsePlanJson(json);
  if (!parsed.ok || hasHiddenCharacters(parsed.value)) throw new ApprovedPlanMismatchError(proposal);
  return parsed.value;
}

async function storedPlanJson(proposal: Proposal): Promise<string | undefined> {
  const json = await getTextArtefact(proposal.artefactPrefix, 'plan/plan.json', MAX_PLAN_ARTEFACT_BYTES);
  return json?.truncated ? undefined : json?.text;
}

async function approvedPlan(proposal: Proposal): Promise<{ json: string; markdown: string }> {
  return checkApprovedPlan(proposal, await storedPlanJson(proposal));
}

/**
 * What a revision starts from: the plan it revises, as its comment showed it,
 * and the change asked for in the comment that asked for the revision.
 */
export function revisionFor(workItem: WorkItem, proposal: Proposal, plan: Plan): NonNullable<SeedContext['revision']> {
  const command = issueCommand(workItem.body);
  if (command.kind !== 'revise') throw new Error('a revision is asked for with `revise`');
  return {
    proposal: proposal.workItemId,
    previous: planText(plan),
    request: redactSecrets(command.request).slice(0, MAX_REVISION_BYTES / 4),
    by: workItem.requestedBy,
  };
}

const prepareKey = (input: PrepareInput): RunKey => ({ workItemId: unvalidatedId(input.workItem) });

export const handler = staged('prepare', prepareKey, {}, async (input, stageLog): Promise<WorkContext> => {
  assertWorkItem(input.workItem);
  const workItem = input.workItem;
  assertUuid(workItem.id, 'WorkItem id');
  const { intake } = input;
  if (intake.route === 'refuse') throw new Error(`Prepare reached for route ${intake.route}`);
  const { route, attempt, artefactPrefix: prefix, resumedFrom, rework, approves, revises } = intake;
  const log = stageLog.with({ attempt });

  const branch = assertGitBranch(intake.branch, 'work branch');
  const plan = approves ? await approvedPlan(approves) : undefined;
  const revision = revises ? revisionFor(workItem, revises, checkProposedPlan(revises, await storedPlanJson(revises))) : undefined;
  const { baseCommit, baseBranch, reworkPoints: points } = await seedSession({
    providers: PREPARE_PROVIDERS,
    role: 'builder',
    workItem,
    branch,
    artefactPrefix: prefix,
    stage: 'prepare',
    ...(resumedFrom ? { resumedFrom } : {}),
    ...(rework ? { rework } : {}),
    extras: { route, ...(plan ? { plan } : {}), ...(approves ? { approves: approves.workItemId } : {}), ...(revision ? { revision } : {}) },
  });
  await handOverWorkspace(sessionTarget(workItem.id, 'builder'));

  await putJsonArtefact(prefix, 'prepare/branch.json', {
    branch,
    baseSha: baseCommit,
    factorialVersion: input.factorialVersion,
    route,
    ...(resumedFrom ? { resumedFromWorkItemId: resumedFrom.workItemId } : {}),
    ...(approves ? { approves: approves.workItemId } : {}),
    ...(revises ? { revises: revises.workItemId } : {}),
  });

  await recordProgress(workItem.id, 'prepared', {
    branch,
    baseBranch,
    sessionId: workItem.id,
    ...(rework ? { reworkOf: { previousWorkItemId: rework.previousWorkItemId, prNumber: rework.pullRequest.number } } : {}),
    ...(resumedFrom ? { resumedFrom: resumedFrom.workItemId } : {}),
  });
  log.info('session prepared', { branch, baseBranch, route, threadKey: intake.threadKey, rework: rework !== undefined, resumedFrom: resumedFrom?.workItemId, approves: approves?.workItemId });

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
    route,
    ...(approves ? { approves } : {}),
  };
});
