import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addCallUsage, emptyRunUsage } from './usage.ts';

describe('addCallUsage', () => {
  it('sums every call instead of keeping the last one', () => {
    let run = emptyRunUsage();
    run = addCallUsage(run, { inputTokens: 8000, outputTokens: 200, totalTokens: 8200, cacheReadInputTokens: 0 });
    run = addCallUsage(run, { inputTokens: 12000, outputTokens: 300, totalTokens: 12300, cacheReadInputTokens: 7900 });
    run = addCallUsage(run, { inputTokens: 10000, outputTokens: 100, totalTokens: 10100, cacheReadInputTokens: 9800 });
    assert.deepEqual(run, {
      modelCalls: 3,
      inputTokens: 30000,
      outputTokens: 600,
      totalTokens: 30600,
      cacheReadInputTokens: 17700,
      cacheWriteInputTokens: 0,
      uncachedInputTokens: 12300,
      maxCallInputTokens: 12000,
      lastCallInputTokens: 10000,
    });
  });

  it('derives the total when a record omits it and ignores missing or bad values', () => {
    const run = addCallUsage(emptyRunUsage(), { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: Number.NaN });
    assert.equal(run.totalTokens, 105);
    assert.equal(run.cacheReadInputTokens, 0);
    assert.equal(run.uncachedInputTokens, 100);
  });

  it('leaves the total unchanged when there is no usage record', () => {
    assert.deepEqual(addCallUsage(emptyRunUsage(), undefined), emptyRunUsage());
  });
});
