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
 * The agent's session is treated as hostile once the agent has run: it may
 * have planted git hooks, configuration or background processes. So no
 * credential ever enters it. The new commits leave the session as a git
 * bundle (pure data), and the push happens in a separate clean-room session
 * from a pristine clone, with hooks disabled and the token sent as a header.
 *
 * Once Collect has finished with a session it stops it, so it does not idle
 * until the Runtime's timeout: the clean room as soon as the push returns, the
 * agent's just before Collect returns. A stop is never in a `finally`: the
 * state's retry runs Collect again on the same session, so a failed attempt
 * leaves it running. A failed stop is logged and does not fail the stage.
 */
import { putArtefact, putBinaryArtefact, putJsonArtefact, redactSecrets } from '@factorial/artefacts';

import type { WorkContext } from '../lib/context.ts';
import { LIMIT_COMMIT_MESSAGE } from '../lib/continue-files.ts';
import { commitIdentity, repositoryToken } from '../lib/github.ts';
import { builderIncomplete, type StepFailure } from '../lib/incomplete.ts';
import { runKey, type Logger } from '../lib/log.ts';
import { stageError, staged, stepError, type ProgressInput, type StagePolicy } from '../lib/progress.ts';
import { InvalidPlanError, checkPlanFiles, parsePlanRead, planDigest, readPlanScript, type CheckedPlan, type PlanDigest } from '../lib/plan-files.ts';
import { planSize } from '../lib/plan-size.ts';
import { asAgent, cleanRoomTarget, mustRun, runCommand, sessionTarget, stopSessionQuietly, type SessionTarget } from '../lib/session.ts';
import { exportSessionFiles } from '../lib/session-files.ts';
import {
  HARDENED_GIT_ENV,
  assertCommitSha,
  assertGitBranch,
  assertGitHubName,
  assertGitIdentity,
  gitAuthHeader,
  shellQuote,
} from '../lib/shell.ts';
import { recordProgress } from '../lib/table.ts';

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
    `git diff --name-only ${base} HEAD`,
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
  return changedPaths.some((path) => path.startsWith('.github/workflows/'));
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
 * Import the bundle into a pristine clone and push exactly the expected
 * commit to the work branch. Runs in the clean-room session.
 *
 * `baseCommit` is the commit the work branch must currently point at: the
 * tip of the base branch for a new item, the head the agent started from
 * for rework. The rewrite replays the bundle's commits on top of it, so the
 * push is always a fast-forward; the check refuses anything else, and no
 * force is ever passed.
 */
export function cleanRoomPushScript(params: {
  owner: string;
  name: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  headSha: string;
  /** True for rework, which pushes onto an existing branch; false for a fresh branch, which must not exist yet. */
  existingBranch: boolean;
  token: string;
  bundleBase64: string;
  /** Author and committer for every pushed commit; the agent's own identity is discarded. */
  identity: { name: string; email: string };
}): string {
  const owner = assertGitHubName(params.owner, 'repository owner');
  const name = assertGitHubName(params.name, 'repository name');
  const headSha = assertCommitSha(params.headSha, 'head sha');
  const baseCommit = assertCommitSha(params.baseCommit, 'base commit');
  const branch = assertGitBranch(params.branch, 'work branch');
  const baseBranch = assertGitBranch(params.baseBranch, 'base branch');
  const identity = assertGitIdentity(params.identity);
  const url = `https://github.com/${owner}/${name}.git`;
  const auth = shellQuote(gitAuthHeader(params.token));
  const ident = [
    `GIT_AUTHOR_NAME=${shellQuote(identity.name)}`,
    `GIT_AUTHOR_EMAIL=${shellQuote(identity.email)}`,
    `GIT_COMMITTER_NAME=${shellQuote(identity.name)}`,
    `GIT_COMMITTER_EMAIL=${shellQuote(identity.email)}`,
  ].join(' ');
  return [
    'set -euo pipefail',
    HARDENED_GIT_ENV,
    'rm -rf /workspace/push && mkdir -p /workspace/push && cd /workspace/push',
    `printf '%s' ${shellQuote(params.bundleBase64)} | base64 -d > incoming.bundle`,
    `git -c core.hooksPath=/dev/null -c http.extraHeader=${auth} clone --quiet --bare --filter=blob:none ${shellQuote(url)} repo.git`,
    'cd repo.git',
    // The clone is blob-less, so importing the bundle makes git fetch the
    // unchanged files' blobs from origin on demand; that lazy fetch needs
    // the same header or it fails asking for a username.
    `git -c core.hooksPath=/dev/null -c http.extraHeader=${auth} fetch --quiet ../incoming.bundle HEAD`,
    `test "$(git rev-parse FETCH_HEAD)" = ${shellQuote(headSha)}`,
    // An existing branch must still be at the head the session started from,
    // so the push is a fast-forward; refuse and fail loudly if it has moved.
    // A fresh branch must not exist yet, so the push never overwrites one.
    params.existingBranch
      ? `test "$(git rev-parse --verify --quiet refs/heads/${branch})" = ${shellQuote(baseCommit)}`
      : `test -z "$(git rev-parse --verify --quiet refs/heads/${branch})"`,
    `git merge-base --is-ancestor ${shellQuote(baseCommit)} FETCH_HEAD`,
    `base=${shellQuote(baseCommit)}`,
    'test -z "$(git rev-list --merges "$base..FETCH_HEAD")"',
    'new=$base',
    'for c in $(git rev-list --reverse "$base..FETCH_HEAD"); do',
    `  new=$(git log -1 --format=%B "$c" | ${ident} GIT_AUTHOR_DATE="$(git log -1 --format=%aI "$c")" git commit-tree "$c^{tree}" -p "$new")`,
    'done',
    `git -c core.hooksPath=/dev/null -c http.extraHeader=${auth} push --quiet origin "$new:${`refs/heads/${branch}`}"`,
    'cd / && rm -rf /workspace/push',
    'echo "$new"',
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

async function storeBundle(ctx: WorkContext, bundleBase64: string, log: Logger): Promise<void> {
  try {
    await putBinaryArtefact(ctx.artefactPrefix, 'build/bundle.git', Buffer.from(bundleBase64, 'base64'), 'application/octet-stream');
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
 */
export function roundStartFor(ctx: WorkContext, start: RoundStart | null | undefined): RoundStart {
  if (start) return { ...start, commit: assertCommitSha(start.commit, 'round start commit') };
  return {
    commit: ctx.baseCommit,
    existing: ctx.rework !== undefined || ctx.resumedFrom !== undefined,
    pushed: false,
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
  const { commitCount, itemCommitCount, headSha, changedPaths, summary } = parseInspection(inspection.stdout);
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
    // Nothing new this round, but earlier rounds' work is on the branch: that
    // pushed head is what is tested.
    log.info('no new commits this round; the branch keeps the earlier rounds\' work', { incomplete, headSha: start.commit });
    await stopSessionQuietly(agentSession, log);
    return { pushed: true, commitCount, itemCommitCount, headSha: start.commit, summary, incomplete, ...digest };
  }
  if (commitCount === 0) {
    if (!salvage) await recordProgress(ctx.workItem.id, 'no-changes', { headSha, summary, ...planFields });
    log.info('agent made no commits', { incomplete });
    await stopSessionQuietly(agentSession, log);
    return { pushed: false, commitCount, itemCommitCount, headSha, summary, incomplete, ...digest };
  }

  const bundle = await mustRun(agentSession, asAgent(bundleScript(start.commit, headSha)), 300);
  const bundleBase64 = bundle.stdout.trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(bundleBase64)) {
    throw new Error('Bundle export did not produce base64 output');
  }
  await storeBundle(ctx, bundleBase64, log);

  const repo = { owner: ctx.workItem.repository.owner, name: ctx.workItem.repository.name };
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
  const push = await mustRun(
    cleanRoomTarget(ctx.workItem.id),
    cleanRoomPushScript({
      owner: repo.owner,
      name: repo.name,
      branch: ctx.branch,
      baseBranch: ctx.baseBranch,
      baseCommit: start.commit,
      headSha,
      existingBranch: start.existing,
      token,
      bundleBase64,
      identity,
    }),
    600,
  );
  // The pushed head differs from the agent's: the commits were re-created
  // with the App's identity. Everything downstream tests and reviews this one.
  const pushedSha = assertCommitSha(push.stdout.trim().split('\n').pop() ?? '', 'pushed head');
  // The push is done and the clean room is not used again.
  await stopSessionQuietly(cleanRoomTarget(ctx.workItem.id), log);

  await recordProgress(ctx.workItem.id, salvage ? 'salvaged' : 'pushed', {
    headSha: pushedSha,
    agentHeadSha: headSha,
    commitCount,
    changedPaths: changedPaths.slice(0, 200),
    editsWorkflows,
    summary,
    bundleBytes: Math.floor((bundleBase64.length * 3) / 4),
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
  return { pushed: true, commitCount, itemCommitCount, headSha: pushedSha, summary, incomplete, ...digest };
}

export const handler = staged('collect', (input: CollectInput) => runKey(input), collectStage, (input, log) => collect(input, log));
