import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runtimeInfoOf, usageRecord } from './run-record.ts';
import { addCallUsage, emptyRunUsage } from './usage.ts';

describe('usageRecord', () => {
  const calls = [
    { inputTokens: 100, outputTokens: 10 },
    { inputTokens: 200, outputTokens: 20 },
  ];
  const usage = calls.reduce(addCallUsage, emptyRunUsage());
  const base = {
    version: { runtimeName: 'factorial_builder', runtimeVersion: '7', modelId: 'eu.anthropic.claude-sonnet-5-5' },
    toolCalls: 4,
    startedAt: 0,
    endedAt: 61_400,
    usage,
    calls,
  };

  it('holds the summed usage, each call, the version and the outcome', () => {
    assert.deepEqual(usageRecord({ ...base, stopReason: 'success', interrupted: false }), {
      runtimeName: 'factorial_builder',
      runtimeVersion: '7',
      modelId: 'eu.anthropic.claude-sonnet-5-5',
      stopReason: 'success',
      toolCalls: 4,
      durationSeconds: 61,
      usage,
      calls,
    });
  });

  it('says interrupted when the task was stopped, whatever the run last said', () => {
    const record = usageRecord({ ...base, stopReason: 'error_max_turns', interrupted: true, error: 'interrupted' });
    assert.equal(record.stopReason, 'interrupted');
    assert.equal(record.error, 'interrupted');
  });

  it('says error when the stream failed before a stop reason arrived', () => {
    assert.equal(usageRecord({ ...base, stopReason: undefined, interrupted: false, error: 'boom' }).stopReason, 'error');
  });
});

it("reads a runtime version's model and limits from its environment", () => {
  assert.deepEqual(
    runtimeInfoOf({
      FACTORIAL_ROLE: 'builder',
      FACTORIAL_MODEL: 'eu.anthropic.claude-sonnet-5-5',
      FACTORIAL_EXPLORE_MODEL: 'eu.anthropic.claude-haiku-5-5',
      FACTORIAL_MAX_TURNS: '150',
      FACTORIAL_MAX_BUDGET_USD: '10',
      FACTORIAL_MAX_DURATION_SECONDS: '6600',
    }),
    {
      modelId: 'eu.anthropic.claude-sonnet-5-5',
      exploreModelId: 'eu.anthropic.claude-haiku-5-5',
      maxTurns: 150,
      maxBudgetUsd: 10,
      maxDurationSeconds: 6600,
    },
  );
  assert.deepEqual(runtimeInfoOf(undefined), {});
});
