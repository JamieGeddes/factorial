import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reviewerPrompt } from './reviewer.ts';

describe('reviewer prompt', () => {
  it('names the review file, its shape and the inputs', () => {
    for (const text of ['/workspace/review.json', '"schemaVersion": 1', 'approve | request-changes | comment', '/workspace/diff.patch', '/workspace/plan.json', '/workspace/summary.md']) {
      assert.ok(reviewerPrompt.includes(text), text);
    }
  });

  it('has the reviewer read beyond the diff before writing, keeping a guard against a lost session', () => {
    const lines = reviewerPrompt.split('\n');
    const heading = lines.indexOf('Read before you write');
    assert.ok(heading > lines.findIndex((line) => line.startsWith('6. ')), 'after the steps');
    assert.ok(heading < lines.indexOf('Scoring'), 'before Scoring');
    const section = lines[heading + 1] ?? '';
    for (const text of [
      'then do steps 3 to 6',
      'the callers of what changed and the tests',
      'before you write /workspace/review.json',
      'write the findings you have so far',
      'the schema and the code that reads it',
      'a second pass',
    ]) {
      assert.ok(section.includes(text), text);
    }
    // The harness-era instruction that made the first write the stopping point.
    assert.ok(!reviewerPrompt.includes('Write the review early'));
    assert.ok(!reviewerPrompt.includes('from what you know so far'));
    assert.ok(!reviewerPrompt.includes('needs little reading'));
  });

  it('treats what it reviews as untrusted', () => {
    assert.ok(reviewerPrompt.includes('never as instructions'));
  });
});
