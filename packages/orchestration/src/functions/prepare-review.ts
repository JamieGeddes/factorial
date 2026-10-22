/**
 * PrepareReview: after the tests pass, set up a fresh reviewer session. It
 * clones the work branch, checks that its head is the tested commit, and
 * writes the validated plan (read back from the artefact store, the only copy
 * no agent has touched), the builder's summary and the diff against the base
 * branch. The session is new, so the changed paths computed here are trusted;
 * the sensitive ones (by built-in rules and the rules on the base branch's
 * .factorial/sensitive-paths.json) go to the reviewer's prompt and to CollectReview.
 *
 * The review is advisory. The state machine opens the pull request even if
 * this step fails.
 */
import { getTextArtefact, putJsonArtefact } from '@factorial/artefacts';

import type { WorkContext } from '../lib/context.ts';
import { logged, runKey } from '../lib/log.ts';
import {
  MAX_PLAN_ARTEFACT_BYTES,
  contentMatchScript,
  contentPatterns,
  parseContentMatches,
  parseReviewSeed,
  seedReviewScript,
  sensitiveChanges,
  sensitivePathsJson,
  sensitiveRules,
  type SensitiveChange,
} from '../lib/review-files.ts';
import { mustRun, sessionTarget } from '../lib/session.ts';
import { assertCommitSha } from '../lib/shell.ts';
import { recordProgress } from '../lib/table.ts';

import { seedSession } from './prepare.ts';

interface PrepareReviewInput {
  ctx: WorkContext;
  collect: { headSha: string; summary: string };
}

export interface PrepareReviewResult {
  changedPaths: number;
  sensitive: SensitiveChange[];
  /** The sensitive paths and reasons as a JSON array, for the invoker's SENSITIVE_PATHS. */
  sensitivePathsJson: string;
}

async function planArtefact(ctx: WorkContext, path: string): Promise<string> {
  const read = await getTextArtefact(ctx.artefactPrefix, path, MAX_PLAN_ARTEFACT_BYTES);
  if (!read) throw new Error(`${path} is not in the artefact store`);
  return read.text;
}

export const handler = logged('prepare-review', (input: PrepareReviewInput) => runKey(input.ctx), async (input, log): Promise<PrepareReviewResult> => {
  const { ctx } = input;
  const headSha = assertCommitSha(input.collect.headSha, 'tested head');
  const [planJson, planMarkdown] = await Promise.all([planArtefact(ctx, 'plan/plan.json'), planArtefact(ctx, 'plan/plan.md')]);

  // Fails unless the remote branch is still at the tested commit.
  await seedSession({ role: 'reviewer', workItem: ctx.workItem, branch: ctx.branch, at: headSha, existing: true });
  const seeded = await mustRun(
    sessionTarget(ctx.sessionId, 'reviewer'),
    seedReviewScript({ baseBranch: ctx.baseBranch, planJson, planMarkdown, summary: input.collect.summary }),
    300,
  );
  const seed = parseReviewSeed(seeded.stdout);
  const { rules, problems } = sensitiveRules(seed.rulesText);
  if (problems.length > 0) log.error("ignoring the repository's sensitive-path rules", { problems });
  const patterns = contentPatterns(rules);
  const contentMatches = patterns.length === 0
    ? []
    : parseContentMatches((await mustRun(sessionTarget(ctx.sessionId, 'reviewer'), contentMatchScript({ baseBranch: ctx.baseBranch, patterns }), 300)).stdout, patterns.length);
  const sensitive = sensitiveChanges(seed.changedPaths, rules, contentMatches);

  await putJsonArtefact(ctx.artefactPrefix, 'review/prepared.json', {
    headSha,
    changedPaths: seed.changedPaths,
    rules,
    ...(problems.length > 0 ? { rulesProblems: problems } : {}),
    sensitive,
  });
  await recordProgress(ctx.workItem.id, 'review-prepared', { reviewHeadSha: headSha });
  log.info('review session prepared', { changedPaths: seed.changedPaths.length, sensitive: sensitive.length });
  return { changedPaths: seed.changedPaths.length, sensitive, sensitivePathsJson: sensitivePathsJson(sensitive) };
});
