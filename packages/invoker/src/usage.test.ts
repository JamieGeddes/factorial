import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addCallUsage, emptyRunUsage, previousRoundsUsage } from './usage.ts';

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

describe('previousRoundsUsage', () => {
  const total = { ...emptyRunUsage(), modelCalls: 40, inputTokens: 900000, outputTokens: 20000, totalTokens: 920000 };

  it('has nothing before the second round', () => {
    assert.equal(previousRoundsUsage({ buildUsageTotal: total }, 'build', undefined), undefined);
    assert.equal(previousRoundsUsage({ buildUsageTotal: total }, 'build', 1), undefined);
  });

  it("reads the stage's total across rounds", () => {
    assert.deepEqual(previousRoundsUsage({ buildUsageTotal: total, stages: {} }, 'build', 2), total);
  });

  it('reads the total, not the latest round, from a row written before the interim fields were dropped', () => {
    const row = { buildUsageTotal: total, usage: { ...emptyRunUsage(), modelCalls: 5 }, buildRounds: 1, stopReason: 'max_turns' };
    assert.deepEqual(previousRoundsUsage(row, 'build', 2), total);
  });

  it('has nothing when the row holds no total', () => {
    assert.equal(previousRoundsUsage(undefined, 'build', 2), undefined);
    assert.equal(previousRoundsUsage({ usage: total }, 'build', 2), undefined);
  });

  it('counts a missing or malformed figure as 0', () => {
    assert.deepEqual(previousRoundsUsage({ buildUsageTotal: { modelCalls: 3, inputTokens: 'x' } }, 'build', 3), { ...emptyRunUsage(), modelCalls: 3 });
  });
});
