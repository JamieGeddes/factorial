import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WorkContext } from '../lib/context.ts';
import { prepareReviewStage, type PrepareReviewInput } from './prepare-review.ts';

const input = (verify: NonNullable<PrepareReviewInput['verify']>): PrepareReviewInput => ({ ctx: {} as WorkContext, collect: { headSha: 'a'.repeat(40), summary: '' }, verify });

test('reaching review closes a Verify that ran, and records no Verify stage when it was skipped', () => {
  const passed = { name: 'checks', required: true, outcome: 'passed' as const, sha: 'a'.repeat(40), durationSeconds: 60 };
  assert.deepEqual(prepareReviewStage.closes?.(input({ verifiers: [passed] })), [{ stage: 'Verify', outcome: 'succeeded' }]);
  assert.deepEqual(prepareReviewStage.closes?.(input({ skipped: 'JamieGeddes/other declares no verifiers (no .factorial/verifiers.json on main)' })), []);
});
