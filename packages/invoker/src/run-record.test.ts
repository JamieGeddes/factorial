import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { progressEventErrors, progressEvent } from '@factorial/progress';

import { roundUsd, runEntryOf, runtimeInfoOf, usageRecord } from './run-record.ts';
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
    assert.deepEqual(usageRecord({ ...base, stopReason: 'completed', interrupted: false }), {
      runtimeName: 'factorial_builder',
      runtimeVersion: '7',
      modelId: 'eu.anthropic.claude-sonnet-5-5',
      stopReason: 'completed',
      toolCalls: 4,
      durationSeconds: 61,
      usage,
      calls,
    });
  });

  it('says interrupted when the task was stopped, whatever the run last said', () => {
    const record = usageRecord({ ...base, stopReason: 'max_turns', interrupted: true, error: 'interrupted' });
    assert.equal(record.stopReason, 'interrupted');
    assert.equal(record.error, 'interrupted');
  });

  it('records what the live feed published, dropped and stored (#194)', () => {
    const live = { published: 280, dropped: 4, chunks: { count: 2, lastSeq: 284, failed: 0 } };
    assert.deepEqual(usageRecord({ ...base, stopReason: 'completed', interrupted: false, live }).live, live);
    assert.equal('live' in usageRecord({ ...base, stopReason: 'completed', interrupted: false }), false);
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
      FACTORIAL_EFFORT: 'high',
      FACTORIAL_MAX_TURNS: '150',
      FACTORIAL_MAX_BUDGET_USD: '10',
      FACTORIAL_MAX_DURATION_SECONDS: '6600',
      FACTORIAL_RUN_CONTRACT: '1',
    }),
    {
      modelId: 'eu.anthropic.claude-sonnet-5-5',
      exploreModelId: 'eu.anthropic.claude-haiku-5-5',
      effort: 'high',
      maxTurns: 150,
      maxBudgetUsd: 10,
      maxDurationSeconds: 6600,
      runContract: 1,
    },
  );
  assert.deepEqual(runtimeInfoOf(undefined), {});
});

describe('runEntryOf', () => {
  const usage = [{ inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 800 }].reduce(addCallUsage, emptyRunUsage());
  const id = '84c2d660-d3ec-11f1-92c7-34ac6b750765';
  const full = runEntryOf({
    role: 'builder',
    sessionId: `${id}-r2`,
    version: { runtimeName: 'factorial_builder', runtimeVersion: '37', runContract: 1, modelId: 'global.anthropic.claude-sonnet-5-5', effort: 'high', maxTurns: 150 },
    harness: { name: 'pi', version: '1.4.0', turns: 12, costUsd: 0.31, configuredModels: [{ id: 'x', purpose: 'main' }], deniedToolCalls: 1 },
    stopReason: 'completed',
    outcome: 'complete',
    toolCalls: 9,
    durationSeconds: 495,
    usage,
    record: { transcriptKey: `${id}/2/build/round-2/transcript.jsonl`, usageKey: `${id}/2/build/round-2/usage.json`, transcriptBytes: 144461 },
  });

  it('keeps the metadata and leaves out the limits, calls and what the harness said', () => {
    assert.deepEqual(full, {
      role: 'builder',
      runtimeName: 'factorial_builder',
      runtimeVersion: '37',
      runContract: 1,
      harness: { name: 'pi', version: '1.4.0' },
      modelId: 'global.anthropic.claude-sonnet-5-5',
      effort: 'high',
      sessionId: `${id}-r2`,
      toolCalls: 9,
      turns: 12,
      durationSeconds: 495,
      stopReason: 'completed',
      outcome: 'complete',
      usage,
      costUsd: 0.31,
      transcriptKey: `${id}/2/build/round-2/transcript.jsonl`,
      usageKey: `${id}/2/build/round-2/usage.json`,
    });
  });

  it('fits the progress contract', () => {
    const row = {
      workItemId: id,
      workItem: {
        source: { type: 'github-issue', url: 'https://github.com/JamieGeddes/factorial/issues/15' },
        repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' },
      },
    };
    assert.deepEqual(progressEventErrors(progressEvent(row, 'Build#2', 'succeeded', '2026-10-30T22:00:00.000Z', { run: full })), []);
  });

  it('holds what there is for a run that never started', () => {
    assert.deepEqual(
      runEntryOf({ role: 'reviewer', sessionId: id, version: {}, stopReason: 'interrupted', toolCalls: 0, durationSeconds: 3, usage: emptyRunUsage() }),
      { role: 'reviewer', sessionId: id, toolCalls: 0, durationSeconds: 3, stopReason: 'interrupted', usage: emptyRunUsage() },
    );
  });
});

describe('roundUsd', () => {
  it('rounds to 4 decimal places and keeps undefined', () => {
    assert.equal(roundUsd(0.25970079999999995), 0.2597);
    assert.equal(roundUsd(0.08171640000000001), 0.0817);
    assert.equal(roundUsd(0), 0);
    assert.equal(roundUsd(undefined), undefined);
  });

  it('is recorded in usageRecord and runEntryOf, with an absent cost staying absent', () => {
    const common = { version: {}, stopReason: 'completed', toolCalls: 0, usage: emptyRunUsage() };
    const model = { id: 'x', purpose: 'main' };
    const record = usageRecord({
      ...common,
      interrupted: false,
      startedAt: 0,
      endedAt: 1000,
      calls: [],
      harness: {
        costUsd: 0.25970079999999995,
        models: [
          { model, usage: {} as never, costUsd: 0.08171640000000001 },
          { model, usage: {} as never },
        ],
      },
    });
    assert.equal(record.harness?.costUsd, 0.2597);
    assert.equal(record.harness?.models?.[0]?.costUsd, 0.0817);
    assert.ok(!('costUsd' in (record.harness?.models?.[1] ?? {})));

    const entry = (costUsd: number | undefined) => runEntryOf({ ...common, role: 'builder', sessionId: 's', durationSeconds: 1, harness: costUsd === undefined ? {} : { costUsd } });
    assert.equal(entry(0.25970079999999995).costUsd, 0.2597);
    assert.equal(entry(0.08171640000000001).costUsd, 0.0817);
    assert.ok(!('costUsd' in entry(undefined)));
    assert.ok(!('costUsd' in usageRecord({ ...common, interrupted: false, startedAt: 0, endedAt: 1, calls: [], harness: {} }).harness!));
  });
});
