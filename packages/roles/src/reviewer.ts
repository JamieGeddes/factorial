/**
 * The reviewer: reads the change at the commit the tests passed on and
 * writes review.json. Advisory: what it leaves behind is judged by
 * CollectReview, so an early stop is not an error in itself.
 */
import { reviewPrompt } from './first-message.ts';
import type { RoleManifest } from './manifest.ts';

export const reviewer: RoleManifest = {
  name: 'reviewer',
  stage: 'review',
  statuses: { running: 'reviewing', done: 'review-done', failed: 'review-error' },
  models: [],
  mustFinish: false,
  rounds: false,
  ledger: 'stage',
  notesPlan:
    '_The plan the builder followed is /workspace/plan.json, with its explanation in /workspace/plan.md. Your review goes in /workspace/review.json, not here. Keep working notes under # Notes._',
  firstMessage: (workItem, branch, baseBranch, options) => reviewPrompt(workItem, branch, baseBranch, options.sensitivePaths ?? []),
};
