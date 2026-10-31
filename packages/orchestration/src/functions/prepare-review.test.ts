import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WorkContext } from '../lib/context.ts';
import { prepareReviewStage, type PrepareReviewInput } from './prepare-review.ts';

const input = (collect: PrepareReviewInput['collect']): PrepareReviewInput => ({ ctx: {} as WorkContext, collect });

test('reaching review closes a Test that ran, and records no Test stage when it was skipped', () => {
  assert.deepEqual(prepareReviewStage.closes?.(input({ headSha: 'a'.repeat(40), summary: '' })), [{ stage: 'Test', outcome: 'succeeded' }]);
  assert.deepEqual(prepareReviewStage.closes?.(input({ headSha: 'a'.repeat(40), summary: '', testSkipReason: 'JamieGeddes/other has no .github/workflows/test.yml on main' })), []);
});
