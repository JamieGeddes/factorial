/**
 * Collect: after the agent finishes, inspect its session deterministically,
 * commit anything it left uncommitted, and bring back the summary it wrote.
 * Before pushing, it stores the session's files and the bundle in the
 * artefact store, so the record survives the session.
 *
 * It also reads the plan the builder wrote with its plan subagent, validates
 * it against the plan contract and stores it under `plan/`, as CollectPlan
 * did while the planner was a separate stage. A build that ends without a
 * valid plan pushes nothing and ends as InvalidPlan; a failed build's work
 * is saved whatever the plan, and a valid plan is kept for the next round.
 *
 * A change under `.github/workflows/` or `.github/actions/` is pushed only
 * when the base branch's `.factorial/workflow-changes.json` opts in (#296);
 * otherwise, salvage included, nothing is pushed and the turn ends as
 * WorkflowChangeRefused.
 *
 * On the propose route (#169) Collect pushes nothing, ever: a valid plan
 * with no change to the repository is `proposed`, a builder that changed
 * anything fails the turn (ProposalChanged), and a failed build saves
 * nothing, since there is no work to save.
 *
 * The agent's session is treated as hostile once the agent has run: it may
 * have planted git hooks, configuration or background processes. So no
 * credential ever enters it. The new commits leave the session as a git
 * bundle (pure data), and Collect itself is the clean room: it pushes from a
 * pristine clone in its own temporary directory (lib/clean-room.ts), with
 * hooks disabled and the token sent as a header. No model has ever run in
 * the Lambda, so nothing the agent planted can reach the push.
 *
 * Once Collect has finished with the agent's session it stops it, just before
 * returning, so it does not idle until the Runtime's timeout. The stop is
 * never in a `finally`: the state's retry runs Collect again on the same
 * session, so a failed attempt leaves it running. A failed stop is logged and
 * does not fail the stage.
 */
import { putArtefact, putBinaryArtefact, putJsonArtefact, redactSecrets } from '@factorial/artefacts';

import type { WorkContext } from '../lib/context.ts';
import { LIMIT_COMMIT_MESSAGE } from '../lib/continue-files.ts';
import { cleanRoomPush, githubRemote } from '../lib/clean-room.ts';
import { commitIdentity, repositoryClient, repositoryToken } from '../lib/github.ts';
import { builderIncomplete, type StepFailure } from '../lib/incomplete.ts';
import { runKey, type Logger } from '../lib/log.ts';
import { stageError, staged, stepError, type ProgressInput, type StagePolicy } from '../lib/progress.ts';
import { InvalidPlanError, checkPlanFiles, parsePlanRead, planDigest, readPlanScript, type CheckedPlan, type PlanDigest } from '../lib/plan-files.ts';
import { planSize } from '../lib/plan-size.ts';
import { asAgent, mustRun, runCommand, sessionTarget, stopSessionQuietly, type SessionTarget } from '../lib/session.ts';
import { exportSessionFiles } from '../lib/session-files.ts';
import { HARDENED_GIT_ENV, assertCommitSha, shellQuote } from '../lib/shell.ts';
import { recordProgress } from '../lib/table.ts';
import { verifyPlan, type ReadFile, type VerifyPlan } from '../lib/verify.ts';
import { WorkflowChangeRefusedError, workflowChangeAllowed, workflowPaths } from '../lib/workflow-changes.ts';

export interface CollectResult {
  pushed: boolean;
  /** This round's commits. */
  commitCount: number;
  /** The work item's commits over every round so far: from its base commit to the head. */
  itemCommitCount: number;
  headSha: string;
  summary: string;
  /** True when the build stopped at the builder's limit rather than failing: the state machine may start another round. */
  incomplete: boolean;
  /** The validated plan, as the state machine carries it to the pull request; absent when the plan was not valid. */
  plan?: PlanDigest;
  /** On the propose route: the plan is valid and nothing changed, so the turn ends `proposed`. */
  proposed?: boolean;
  /**
   * The verifiers the target's base branch declares (lib/verify.ts), for the
   * Verify stage: the list, why nothing runs (no settings file: the pull
   * request says it was not verified, decided 2026-10-31), or the settings'
   * problems, which end the turn. Absent after a failed build, which is not
   * verified.
   */
  verify?: VerifyPlan;
}

const SECTION = '\n===FACTORIAL-SECTION===\n';
/** Bundles beyond this are almost certainly a mistake (vendored dependencies, binaries). */
const MAX_BUNDLE_BYTES = 8_000_000;

export const LEFTOVER_COMMIT_MESSAGE = 'Apply remaining changes left by the agent';
export const SALVAGE_COMMIT_MESSAGE = 'Save work in progress after the build failed';

/** The message for the commit of uncommitted work: a failed build, a builder that reached its limit, or neither. */
export function leftoverMessage(salvage: boolean, incomplete: boolean): string {
  if (incomplete) return LIMIT_COMMIT_MESSAGE;
  return salvage ? SALVAGE_COMMIT_MESSAGE : LEFTOVER_COMMIT_MESSAGE;
}

export function inspectScript(baseCommit: string, leftoverMessage: string = LEFTOVER_COMMIT_MESSAGE, itemBaseCommit: string = baseCommit): string {
  const base = shellQuote(assertCommitSha(baseCommit, 'base commit'));
  const itemBase = shellQuote(assertCommitSha(itemBaseCommit, 'work item base commit'));
  return [
    'set -uo pipefail',
    HARDENED_GIT_ENV,
    'cd /workspace/repo',
    `if [ -n "$(git -c core.hooksPath=/dev/null status --porcelain=v1)" ]; then git -c core.hooksPath=/dev/null add -A && git -c core.hooksPath=/dev/null -c user.name=Factorial -c user.email=agent@factorial.invalid commit --quiet -m ${shellQuote(leftoverMessage)}; fi`,
    `git rev-list --count ${base}..HEAD`,
    `printf '%s' ${shellQuote(SECTION)}`,
    'git rev-parse HEAD',
    `printf '%s' ${shellQuote(SECTION)}`,
    `git -c core.quotePath=false diff --no-renames --name-only ${base} HEAD`,
    `printf '%s' ${shellQuote(SECTION)}`,
    `git rev-list --count ${itemBase}..HEAD`,
    `printf '%s' ${shellQuote(SECTION)}`,
    'if [ -f /workspace/summary.md ]; then head -c 60000 /workspace/summary.md; fi',
  ].join('\n');
}

export interface Inspection {
  commitCount: number;
  /** Commits since the work item's base commit, over every round. */
  itemCommitCount: number;
  headSha: string;
  /** Paths changed between the base branch and the agent's head. */
  changedPaths: string[];
  summary: string;
}

export function parseInspection(stdout: string): Inspection {
  const [count = '', sha = '', paths = '', itemCount = '', ...rest] = stdout.split(SECTION);
  const summary = rest.join(SECTION);
  const commitCount = Number.parseInt(count.trim(), 10);
  const itemCommitCount = Number.parseInt(itemCount.trim(), 10);
  if (!Number.isInteger(commitCount) || !Number.isInteger(itemCommitCount) || !/^[0-9a-f]{40}$/.test(sha.trim())) {
    throw new Error(`Could not parse session inspection output: ${redactSecrets(stdout.slice(0, 500))}`);
  }
  const changedPaths = paths
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { commitCount, itemCommitCount, headSha: sha.trim(), changedPaths, summary: summary.trim() };
}

/** GitHub refuses pushes that touch Actions workflows unless the token carries the workflows permission. */
export function touchesWorkflows(changedPaths: string[]): boolean {
  return workflowPaths(changedPaths).some((path) => (path.startsWith('"') ? path.slice(1) : path).startsWith('.github/workflows/'));
}

/** Export the new commits from the agent's session as a base64 bundle on stdout. */
export function bundleScript(baseCommit: string, headSha: string): string {
  return [
    'set -euo pipefail',
    HARDENED_GIT_ENV,
    'cd /workspace/repo',
    `test "$(git rev-parse HEAD)" = ${shellQuote(assertCommitSha(headSha, 'head sha'))}`,
    `git -c core.hooksPath=/dev/null bundle create /tmp/factorial.bundle ${shellQuote(assertCommitSha(baseCommit, 'base commit'))}..HEAD >/dev/null 2>&1`,
    `size=$(stat -c %s /tmp/factorial.bundle); if [ "$size" -gt ${MAX_BUNDLE_BYTES} ]; then echo "bundle too large: $size bytes" >&2; exit 3; fi`,
    'base64 -w0 /tmp/factorial.bundle',
  ].join('\n');
}

/**
 * Store the session's files. The record must not cost the work: a failure
 * here is logged, and the push goes ahead.
 */
async function storeSessionFiles(target: SessionTarget, ctx: WorkContext, log: Logger): Promise<void> {
  try {
    const summary = await exportSessionFiles(target, ctx.artefactPrefix);
    log.info('session files stored', { ...summary });
  } catch (error) {
    log.error('session files not stored', { error });
  }
}

/**
 * Read the builder's plan out of its session, check it and store it, valid
 * or not, so a rejected plan can be read; versioning keeps earlier rounds'.
 * Reading fails safe: anything unreadable is an invalid plan.
 */
async function collectPlan(target: SessionTarget, ctx: WorkContext, log: Logger): Promise<CheckedPlan> {
  let checked: CheckedPlan;
  try {
    const read = await mustRun(target, asAgent(readPlanScript()), 120);
    checked = checkPlanFiles(parsePlanRead(read.stdout));
  } catch (error) {
    log.error('plan not read from the session', { error });
    return { ok: false, errors: ['the plan could not be read from the session'] };
  }
  if (checked.markdown !== undefined) await putArtefact(ctx.artefactPrefix, 'plan/plan.md', checked.markdown, 'text/markdown; charset=utf-8');
  if (checked.json !== undefined) await putArtefact(ctx.artefactPrefix, 'plan/plan.json', checked.json, 'application/json');
  await putJsonArtefact(ctx.artefactPrefix, 'plan/validation.json', {
    valid: checked.ok,
    ...(checked.ok ? { size: planSize(checked.plan) } : { errors: checked.errors }),
  });
  return checked;
}

async function storeBundle(ctx: WorkContext, bundle: Buffer, log: Logger): Promise<void> {
  try {
    await putBinaryArtefact(ctx.artefactPrefix, 'build/bundle.git', bundle, 'application/octet-stream');
  } catch (error) {
    log.error('bundle not stored', { error });
  }
}

/**
 * Where a build round started: the commit its session was seeded at, whether
 * the work branch already existed on the remote then, and whether this item
 * has pushed to it in an earlier round. ContinueBuild returns it for rounds 2
 * onwards; round 1's comes from the work context.
 */
export interface RoundStart {
  commit: string;
  existing: boolean;
  pushed: boolean;
}

/**
 * The round's start. Round 1 starts at the work context's base commit, on an
 * existing branch only for rework or a resumed attempt. A later round starts
 * where the previous round's push left the branch, so its bundle and push
 * cover only its own commits, onto the branch as it now is.
 *
 * A resumed attempt's branch already holds the earlier attempt's pushed work
 * (only a run whose tests failed, or a failure that saved work, is resumed),
 * so its round 1 starts as pushed, like a later round: with no new commits,
 * that branch head is what is tested, not reported as no changes. A rework
 * turn with no new commits is still no changes: its pull request is open and
 * the reply says nothing was changed.
 */
export function roundStartFor(ctx: WorkContext, start: RoundStart | null | undefined): RoundStart {
  if (start) return { ...start, commit: assertCommitSha(start.commit, 'round start commit') };
  const resumed = ctx.resumedFrom !== undefined && ctx.rework === undefined;
  return {
    commit: ctx.baseCommit,
    existing: ctx.rework !== undefined || ctx.resumedFrom !== undefined,
    pushed: resumed,
  };
}

export interface CollectInput extends WorkContext, ProgressInput {
  /**
   * Set when the build failed: push whatever the agent left so the work is
   * not lost. Uncommitted changes are committed with a message that says so.
   */
  salvage?: boolean;
  /** The builder's session for this round; the work item id when absent (round 1). */
  builderSessionId?: string;
  /** The Build state's failure, when salvaging: says whether the builder merely ran out. */
  failure?: StepFailure | null;
  /** Where this round started, from ContinueBuild; absent or null in round 1. */
  roundStart?: RoundStart | null;
}

/** SaveWork runs Collect after a failed build: it ends that round's Build, in case the invoker could not. */
const collectStage: StagePolicy<CollectInput, CollectResult> = {
  closes: (input) => (input.salvage ? [{ stage: 'Build', outcome: 'failed', error: stepError(input.failure) ?? stageError('BuildFailed') }] : []),
};

/** What Collect needs from GitHub; a parameter so that a test can run Collect without it. */
export interface CollectDeps {
  commitIdentity: typeof commitIdentity;
  repositoryToken: typeof repositoryToken;
  /** The clean-room push; lib/clean-room.ts's when absent. */
  push?: typeof cleanRoomPush;
  /** A file's text on a branch of the repository, read with a `contents: read` token. */
  readFile?: ReadFile;
}

const repoOf = (ctx: WorkContext) => ({ owner: ctx.workItem.repository.owner, name: ctx.workItem.repository.name });

const fileOnBranch: ReadFile = async (repo, path, ref, maxBytes) => (await repositoryClient(repo, { contents: 'read' })).fileText(repo, path, ref, maxBytes);

/** The verifiers for a pushed change, logged; none for a failed build's saved work, which is not verified. */
async function verifyFor(ctx: WorkContext, salvage: boolean, deps: CollectDeps, log: Logger): Promise<{ verify?: VerifyPlan }> {
  if (salvage) return {};
  const verify = await verifyPlan(repoOf(ctx), ctx.baseBranch, deps.readFile ?? fileOnBranch);
  if ('skipped' in verify) log.info('verify skipped', { reason: verify.skipped });
  else if ('invalid' in verify) log.error('verifier settings invalid', { problems: verify.invalid });
  else log.info('verifiers declared', { verifiers: verify.verifiers.map((v) => v.name) });
  return { verify };
}

/** A builder on the propose route changed the repository: the turn fails, and nothing is pushed. */
export class ProposalChangedError extends Error {
  constructor(commitCount: number) {
    super(`the builder changed the repository on the propose route (${commitCount} commit${commitCount === 1 ? '' : 's'}, counting anything left uncommitted); nothing was pushed`);
    this.name = 'ProposalChanged';
  }
}

/**
 * The propose route's end: the plan is checked as on any route, and the
 * repository must be as it was seeded. Nothing leaves the session but its
 * stored files and the plan; no token is minted.
 */
async function collectProposal(
  agentSession: SessionTarget,
  ctx: WorkContext,
  inspection: Inspection,
  salvage: boolean,
  log: Logger,
): Promise<CollectResult> {
  const { commitCount, itemCommitCount, headSha, summary } = inspection;
  await storeSessionFiles(agentSession, ctx, log);
  const plan = await collectPlan(agentSession, ctx, log);
  const result = { pushed: false, commitCount, itemCommitCount, headSha, summary, incomplete: false };
  // A failed build has nothing to save and does not continue: the failure is reported.
  if (salvage) {
    log.info('proposal build failed; nothing is saved', { commitCount });
    await stopSessionQuietly(agentSession, log);
    return result;
  }
  if (!plan.ok) {
    log.error('plan invalid', { salvage, errors: plan.errors });
    await recordProgress(ctx.workItem.id, 'plan-rejected', { planErrors: plan.errors });
    throw new InvalidPlanError(plan.errors);
  }
  if (commitCount > 0) {
    log.error('proposal changed the repository', { commitCount });
    throw new ProposalChangedError(commitCount);
  }
  await recordProgress(ctx.workItem.id, 'plan-proposed', { planSteps: plan.plan.steps.length, planSize: planSize(plan.plan) });
  log.info('plan proposed', { steps: plan.plan.steps.length });
  await stopSessionQuietly(agentSession, log);
  return { ...result, plan: planDigest(plan.plan), proposed: true };
}

export async function collect(input: CollectInput, log: Logger, deps: CollectDeps = { commitIdentity, repositoryToken }): Promise<CollectResult> {
  const { salvage = false, builderSessionId, failure, roundStart, ...ctx } = input;
  const incomplete = salvage && builderIncomplete(failure);
  const start = roundStartFor(ctx, roundStart);
  const agentSession = sessionTarget(builderSessionId ?? ctx.sessionId);
  // Inspecting and bundling run git in the model's repository, so they run
  // as the user the model ran as (asAgent).
  const inspection = await runCommand(
    agentSession,
    asAgent(inspectScript(start.commit, leftoverMessage(salvage, incomplete), ctx.baseCommit)),
    300,
  );
  if (inspection.exitCode !== 0) {
    throw new Error(`Inspecting the session failed (${inspection.exitCode}): ${redactSecrets(inspection.stderr.slice(-2000))}`);
  }
  const inspected = parseInspection(inspection.stdout);
  if (ctx.route === 'propose') return collectProposal(agentSession, ctx, inspected, salvage, log);
  const { commitCount, itemCommitCount, headSha, changedPaths, summary } = inspected;
  await storeSessionFiles(agentSession, ctx, log);

  const plan = await collectPlan(agentSession, ctx, log);
  if (!plan.ok) {
    log.error('plan invalid', { salvage, errors: plan.errors });
    if (!salvage) {
      await recordProgress(ctx.workItem.id, 'plan-rejected', { planErrors: plan.errors });
      throw new InvalidPlanError(plan.errors);
    }
  }
  // Recorded beside the builder's usage, so a plan's size can be set against what it cost.
  const planFields = plan.ok ? { planSteps: plan.plan.steps.length, planSize: planSize(plan.plan) } : {};
  const digest = plan.ok ? { plan: planDigest(plan.plan) } : {};

  if (commitCount === 0 && start.pushed) {
    // Nothing new this round, but earlier rounds' or a resumed attempt's work
    // is on the branch: that pushed head is what is tested.
    log.info('no new commits this round; the branch keeps the earlier work', { incomplete, headSha: start.commit, resumed: ctx.resumedFrom !== undefined });
    await stopSessionQuietly(agentSession, log);
    return { pushed: true, commitCount, itemCommitCount, headSha: start.commit, summary, incomplete, ...digest, ...(await verifyFor(ctx, salvage, deps, log)) };
  }
  if (commitCount === 0) {
    if (!salvage) await recordProgress(ctx.workItem.id, 'no-changes', { headSha, summary, ...planFields });
    log.info('agent made no commits', { incomplete });
    await stopSessionQuietly(agentSession, log);
    return { pushed: false, commitCount, itemCommitCount, headSha, summary, incomplete, ...digest };
  }

  // Default deny (#296): CI runs an edited workflow with the repository's
  // secrets, so nothing is bundled, stored or pushed (salvage included)
  // unless the base branch opts in.
  const guarded = workflowPaths(changedPaths);
  if (guarded.length > 0) {
    const settings = await workflowChangeAllowed(repoOf(ctx), ctx.baseBranch, deps.readFile ?? fileOnBranch);
    if (!settings.allowed) {
      log.error('workflow change refused', { salvage, paths: guarded.slice(0, 20), problem: settings.problem });
      await stopSessionQuietly(agentSession, log);
      throw new WorkflowChangeRefusedError(guarded);
    }
    log.info('workflow change allowed by the base branch', { paths: guarded.length });
  }

  const exported = await mustRun(agentSession, asAgent(bundleScript(start.commit, headSha)), 300);
  const bundleBase64 = exported.stdout.trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(bundleBase64)) {
    throw new Error('Bundle export did not produce base64 output');
  }
  // The same bytes are stored and pushed.
  const bundle = Buffer.from(bundleBase64, 'base64');
  await storeBundle(ctx, bundle, log);

  const repo = repoOf(ctx);
  const identity = await deps.commitIdentity(repo);
  // Least privilege per push: the workflows permission is requested only
  // when the change edits a workflow file, so an ordinary change never
  // carries it.
  const editsWorkflows = touchesWorkflows(changedPaths);
  const token = await deps.repositoryToken(repo, editsWorkflows ? { contents: 'write', workflows: 'write' } : { contents: 'write' }).catch(
    (error: unknown) => {
      if (editsWorkflows) {
        throw new Error(
          `The change edits GitHub Actions workflows, which needs the Factorial App's "Workflows: read and write" permission (Factorial's docs/github-app.md): ${redactSecrets(String(error))}`,
        );
      }
      throw error;
    },
  );
  // The pushed head differs from the agent's: the commits were re-created
  // with the App's identity. Everything downstream tests and reviews this one.
  const pushedSha = await (deps.push ?? cleanRoomPush)({
    remoteUrl: githubRemote(repo.owner, repo.name),
    branch: ctx.branch,
    baseCommit: start.commit,
    headSha,
    existingBranch: start.existing,
    token,
    bundle,
    identity,
  });

  await recordProgress(ctx.workItem.id, salvage ? 'salvaged' : 'pushed', {
    headSha: pushedSha,
    agentHeadSha: headSha,
    commitCount,
    changedPaths: changedPaths.slice(0, 200),
    editsWorkflows,
    summary,
    bundleBytes: bundle.length,
    ...planFields,
  });
  log.info(salvage ? 'work in progress saved from clean room' : 'branch pushed from clean room', {
    branch: ctx.branch,
    headSha: pushedSha,
    agentHeadSha: headSha,
    commitCount,
  });
  // Nothing reads the agent's session after this.
  await stopSessionQuietly(agentSession, log);
  return { pushed: true, commitCount, itemCommitCount, headSha: pushedSha, summary, incomplete, ...digest, ...(await verifyFor(ctx, salvage, deps, log)) };
}

export const handler = staged('collect', (input: CollectInput) => runKey(input), collectStage, (input, log) => collect(input, log));
