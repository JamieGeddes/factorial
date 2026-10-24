import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { modelIdOf, runtimeInfoOf, usageRecord } from './run-record.ts';
import { addCallUsage, emptyRunUsage } from './usage.ts';

describe('modelIdOf', () => {
  it('reads the model id from whichever provider block is set', () => {
    assert.equal(modelIdOf({ liteLlmModelConfig: { modelId: 'zai/glm-5.3', apiKeyArn: 'arn' } }), 'zai/glm-5.3');
    assert.equal(modelIdOf({ bedrockModelConfig: { modelId: 'eu.model' } }), 'eu.model');
    assert.equal(modelIdOf(undefined), undefined);
    assert.equal(modelIdOf({ $unknown: ['x', {}] }), undefined);
  });
});

describe('usageRecord', () => {
  const calls = [
    { inputTokens: 100, outputTokens: 10 },
    { inputTokens: 200, outputTokens: 20 },
  ];
  const usage = calls.reduce(addCallUsage, emptyRunUsage());
  const base = {
    harness: { harnessName: 'factorial_builder', harnessVersion: '7', modelId: 'zai/glm-5.3' },
    toolCalls: 4,
    startedAt: 0,
    endedAt: 61_400,
    usage,
    calls,
  };

  it('holds the summed usage, each call, the harness and the outcome', () => {
    assert.deepEqual(usageRecord({ ...base, stopReason: 'end_turn', interrupted: false }), {
      harnessName: 'factorial_builder',
      harnessVersion: '7',
      modelId: 'zai/glm-5.3',
      stopReason: 'end_turn',
      toolCalls: 4,
      durationSeconds: 61,
      usage,
      calls,
    });
  });

  it('says interrupted when the task was stopped, whatever the harness last said', () => {
    const record = usageRecord({ ...base, stopReason: 'tool_use', interrupted: true, error: 'interrupted' });
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
