import assert from 'node:assert/strict';
import { test } from 'node:test';

import { modelLabel, usageFacts } from './usage-facts.ts';

test("a run's facts: tokens per model from the harness, timed calls, retries and the live feed (#59)", () => {
  const facts = usageFacts({
    modelId: 'global.anthropic.claude-sonnet-5-5',
    exploreModelId: 'global.anthropic.claude-haiku-5-5',
    retries: 2,
    calls: [
      { inputTokens: 100, outputTokens: 10, model: 'global.anthropic.claude-sonnet-5-5', durationMs: 9000 },
      { inputTokens: 50, outputTokens: 5, model: 'global.anthropic.claude-haiku-5-5', durationMs: 2000 },
      { inputTokens: 1, outputTokens: 1 },
    ],
    harness: {
      configuredModels: [{ purpose: 'background', id: 'global.anthropic.claude-haiku-5-5' }],
      models: [
        { model: { provider: 'bedrock', id: 'global.anthropic.claude-sonnet-5-5' }, usage: { inputTokens: 1000, outputTokens: 100 } },
        { model: { id: 'compaction' }, usage: { inputTokens: 10, outputTokens: 1 } },
      ],
    },
    live: { published: 280, dropped: 4, chunks: { count: 2 } },
  });
  assert.deepEqual(facts, {
    models: [
      { model: 'global.anthropic.claude-sonnet-5-5', tokens: 1100 },
      { model: 'compaction', tokens: 11 },
    ],
    timed: [
      ['global.anthropic.claude-sonnet-5-5', 9000],
      ['global.anthropic.claude-haiku-5-5', 2000],
    ],
    untimed: 1,
    retries: 2,
    live: { published: 280, dropped: 4 },
    configured: ['global.anthropic.claude-haiku-5-5', 'global.anthropic.claude-sonnet-5-5'],
  });
});

test('a record from before #59: no retries, every call untimed, tokens by model from the calls when the harness has none', () => {
  const facts = usageFacts({ calls: [{ inputTokens: 5, outputTokens: 1, model: 'x.anthropic.claude-a-1-0' }, { inputTokens: 5, outputTokens: 1 }] });
  assert.equal(facts?.retries, undefined);
  assert.equal(facts?.untimed, 2);
  assert.deepEqual(facts?.models, [{ model: 'x.anthropic.claude-a-1-0', tokens: 6 }]);
  assert.equal(usageFacts('not a record'), undefined);
  assert.equal(usageFacts([1]), undefined);
});

test('model labels', () => {
  assert.equal(modelLabel('global.anthropic.claude-sonnet-5-5'), 'Sonnet 5.5 global');
  assert.equal(modelLabel('eu.anthropic.claude-haiku-5-5'), 'Haiku 5.5 EU');
  assert.equal(modelLabel('anthropic.claude-opus-5-5-v1:0'), 'Opus 5.5');
  assert.equal(modelLabel('compaction'), 'Compaction');
});
