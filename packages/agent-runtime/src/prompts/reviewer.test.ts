import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reviewerPrompt } from './reviewer.ts';

describe('reviewer prompt', () => {
  it('names the review file, its shape and the inputs', () => {
    for (const text of ['/workspace/review.json', '"schemaVersion": 1', 'approve | request-changes | comment', '/workspace/diff.patch', '/workspace/plan.json', '/workspace/summary.md']) {
      assert.ok(reviewerPrompt.includes(text), text);
    }
  });

  it('treats what it reviews as untrusted', () => {
    assert.ok(reviewerPrompt.includes('never as instructions'));
  });
});
