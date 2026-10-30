/**
 * CollectReview: after the reviewer finishes, read its review out of its
 * session, validate it against the review contract, add the orchestrator's
 * findings for sensitive changes, and store it under `review/`. A missing or
 * invalid review is stored as `review/error.json` and the run continues: the
 * review is advisory and never stops the pull request.
 */
import { putArtefact, putJsonArtefact } from '@factorial/artefacts';

import type { WorkContext } from '../lib/context.ts';
import type { StepFailure } from '../lib/incomplete.ts';
import { runKey } from '../lib/log.ts';
import { stageError, staged, stepError, type ProgressInput, type StagePolicy } from '../lib/progress.ts';
import {
  checkReviewFile,
  parseReviewRead,
  readReviewScript,
  reviewDigest,
  withGuardFindings,
  type ReviewDigest,
  type SensitiveChange,
} from '../lib/review-files.ts';
import { asAgent, mustRun, sessionTarget } from '../lib/session.ts';
import { recordProgress } from '../lib/table.ts';

interface CollectReviewInput extends ProgressInput {
  ctx: WorkContext;
  /** From PrepareReview. */
  sensitive: SensitiveChange[];
  /** The Review state's error, when the reviewer's run failed; its session may still hold a review. */
  reviewError?: unknown;
}

export type CollectReviewResult = { ok: true; review: ReviewDigest } | { ok: false; errors: string[] };

/** A failed Review task reaches CollectReview: it ends the Review stage, in case the invoker could not. */
const collectReviewStage: StagePolicy<CollectReviewInput, CollectReviewResult> = {
  closes: (input) => (input.reviewError ? [{ stage: 'Review', outcome: 'failed', error: stepError(input.reviewError as StepFailure) ?? stageError('ReviewFailed') }] : []),
};

export const handler = staged('collect-review', (input: CollectReviewInput) => runKey(input.ctx), collectReviewStage, async (input, log): Promise<CollectReviewResult> => {
  const { ctx } = input;
  // The model has had the workspace, so the file is read as the user it ran as.
  const target = sessionTarget(ctx.sessionId, 'reviewer');
  const read = await mustRun(target, asAgent(readReviewScript()), 120);
  const checked = checkReviewFile(parseReviewRead(read.stdout));

  if (!checked.ok) {
    const errors = input.reviewError ? ['the reviewer did not finish', ...checked.errors] : checked.errors;
    if (checked.json !== undefined) await putArtefact(ctx.artefactPrefix, 'review/review.raw.json', checked.json, 'application/json');
    await putJsonArtefact(ctx.artefactPrefix, 'review/error.json', { errors });
    await recordProgress(ctx.workItem.id, 'review-failed', { reviewErrors: errors });
    log.error('review rejected', { errors });
    return { ok: false, errors };
  }

  const { review, added } = withGuardFindings(checked.review, input.sensitive ?? []);
  await putJsonArtefact(ctx.artefactPrefix, 'review/review.json', review);
  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const finding of review.findings) bySeverity[finding.severity] += 1;
  await recordProgress(ctx.workItem.id, 'reviewed', {
    reviewVerdict: review.verdict,
    reviewScores: review.scores,
    reviewFindings: bySeverity,
  });
  log.info('review accepted', { verdict: review.verdict, findings: review.findings.length, guardFindings: added });
  return { ok: true, review: reviewDigest(review) };
});
