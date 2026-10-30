/**
 * PrepareReview: after the tests pass, set up a fresh reviewer session. It
 * clones the work branch, checks that its head is the tested commit, and
 * seeds it with the validated plan (read back from the artefact store, the only copy
 * no agent has touched), the builder's summary and the diff against the base
 * branch (`REVIEW_PROVIDERS`). The session is new, so the changed paths computed here are trusted;
 * the sensitive ones (by built-in rules and the rules on the base branch's
 * .factorial/sensitive-paths.json) go to the reviewer's prompt and to CollectReview.
 *
 * The review is advisory. The state machine opens the pull request even if
 * this step fails.
 */
import { getTextArtefact, putJsonArtefact } from '@factorial/artefacts';

import type { WorkContext } from '../lib/context.ts';
import { runKey } from '../lib/log.ts';
import { staged, type ProgressInput, type StagePolicy } from '../lib/progress.ts';
import {
  MAX_PLAN_ARTEFACT_BYTES,
  contentMatchScript,
  contentPatterns,
  parseContentMatches,
  parseReviewSeed,
  reviewFactsScript,
  sensitiveChanges,
  sensitiveRules,
  type SensitiveChange,
} from '../lib/review-files.ts';
import {
  contractChanges,
  dependencyChanges,
  depsScript,
  deployImpact,
  parseDeploySettings,
  parseDeps,
  prFactsDigest,
  testFileChanges,
  type PrFacts,
} from '../lib/pr-facts.ts';
import { handOverWorkspace, mustRun } from '../lib/session.ts';
import { assertCommitSha } from '../lib/shell.ts';
import { recordProgress } from '../lib/table.ts';

import { SENSITIVE_PATHS_SECTION, diffProvider, notesProvider, planProvider, requestProvider, sensitivePathsProvider, summaryProvider, reworkProvider } from '../lib/seed-providers.ts';
import { sectionText, type SeedProvider } from '../lib/seed.ts';

import { cloneSession, placeSeed } from './prepare.ts';

interface PrepareReviewInput extends ProgressInput {
  ctx: WorkContext;
  collect: { headSha: string; summary: string };
}

export interface PrepareReviewResult {
  changedPaths: number;
  sensitive: SensitiveChange[];
  /** The sensitive paths and reasons as a JSON array, for the invoker's SENSITIVE_PATHS. */
  sensitivePathsJson: string;
  /** What the orchestrator computed for the pull request: contracts, dependencies, deploy impact. */
  prFacts: PrFacts;
}

/** What the reviewer's session is seeded with, in this order: the numbering of a rework's points depends on it. */
export const REVIEW_PROVIDERS: readonly SeedProvider[] = [
  requestProvider,
  notesProvider,
  reworkProvider,
  planProvider,
  summaryProvider,
  diffProvider,
  sensitivePathsProvider,
];

async function planArtefact(ctx: WorkContext, path: string): Promise<string> {
  const read = await getTextArtefact(ctx.artefactPrefix, path, MAX_PLAN_ARTEFACT_BYTES);
  if (!read) throw new Error(`${path} is not in the artefact store`);
  return read.text;
}

// The state machine reaches PrepareReview only when the tests passed, so it ends the Test stage.
const prepareReviewStage: StagePolicy<PrepareReviewInput, PrepareReviewResult> = { closes: () => [{ stage: 'Test', outcome: 'succeeded' }] };

export const handler = staged('prepare-review', (input: PrepareReviewInput) => runKey(input.ctx), prepareReviewStage, async (input, log): Promise<PrepareReviewResult> => {
  const { ctx } = input;
  const headSha = assertCommitSha(input.collect.headSha, 'tested head');
  const [planJson, planMarkdown] = await Promise.all([planArtefact(ctx, 'plan/plan.json'), planArtefact(ctx, 'plan/plan.md')]);

  // Fails unless the remote branch is still at the tested commit.
  const session = {
    role: 'reviewer',
    workItem: ctx.workItem,
    branch: ctx.branch,
    at: headSha,
    existing: true,
    ...(ctx.rework ? { rework: ctx.rework } : {}),
  } as const;
  const cloned = await cloneSession(session);
  // Everything the session is asked here is read before the seed is placed, from the clone.
  const facts = parseReviewSeed((await mustRun(cloned.target, reviewFactsScript({ baseBranch: ctx.baseBranch }), 300)).stdout);
  const { rules, problems } = sensitiveRules(facts.rulesText);
  if (problems.length > 0) log.error("ignoring the repository's sensitive-path rules", { problems });
  const patterns = contentPatterns(rules);
  const contentMatches = patterns.length === 0
    ? []
    : parseContentMatches((await mustRun(cloned.target, contentMatchScript({ baseBranch: ctx.baseBranch, patterns }), 300)).stdout, patterns.length);
  const sensitive = sensitiveChanges(facts.changedPaths, rules, contentMatches);

  // Package files and the target's PR settings, both read from git in this fresh session. A failure
  // here must not lose the review: the facts say the dependencies are unknown instead.
  let dependencies: PrFacts['dependencies'] = [];
  let dependenciesUnknown = false;
  let settingsText: string | undefined;
  try {
    const deps = parseDeps((await mustRun(cloned.target, depsScript({ baseBranch: ctx.baseBranch }), 300)).stdout);
    dependencies = dependencyChanges(deps.files, deps.lockText);
    settingsText = deps.settingsText;
  } catch (error) {
    dependenciesUnknown = true;
    log.error('could not read the package files for the pull request', { error });
  }
  // The seed: the last writes into the session, then the workspace is the model's.
  const seed = await placeSeed(cloned, session, REVIEW_PROVIDERS, { plan: { json: planJson, markdown: planMarkdown }, summary: input.collect.summary, sensitive });
  await handOverWorkspace(cloned.target);
  const deploySettings = parseDeploySettings(settingsText);
  if (deploySettings.problems.length > 0) log.error("ignoring the repository's pull request settings", { problems: deploySettings.problems });
  const prFacts = prFactsDigest({
    sensitive,
    contracts: contractChanges(facts.changedPaths),
    testFiles: testFileChanges(facts.changedPaths),
    dependencies,
    ...(dependenciesUnknown ? { dependenciesUnknown } : {}),
    deploy: deployImpact(deploySettings.settings, facts.changedPaths),
  });

  await putJsonArtefact(ctx.artefactPrefix, 'review/prepared.json', {
    headSha,
    changedPaths: facts.changedPaths,
    rules,
    ...(problems.length > 0 ? { rulesProblems: problems } : {}),
    sensitive,
    prFacts,
  });
  await recordProgress(ctx.workItem.id, 'review-prepared', { reviewHeadSha: headSha });
  log.info('review session prepared', { changedPaths: facts.changedPaths.length, sensitive: sensitive.length });
  return { changedPaths: facts.changedPaths.length, sensitive, sensitivePathsJson: sectionText(seed, SENSITIVE_PATHS_SECTION) ?? '[]', prFacts };
});
