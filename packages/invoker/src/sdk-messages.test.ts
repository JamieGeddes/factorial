import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HOST_ERROR, MAX_DURATION, SdkTally, callUsageOf, runUsageOf, runtimeStop, subagentsOf } from './sdk-messages.ts';

const assistant = (id: string, content: unknown[], usage: object, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { id, model: 'claude-sonnet-5-5', content, usage },
});

const result = (subtype: string, extra: object = {}) => ({
  type: 'result',
  subtype,
  num_turns: 3,
  duration_ms: 3512,
  total_cost_usd: 0.0406,
  modelUsage: { 'eu.anthropic.claude-sonnet-5-5': { inputTokens: 4, outputTokens: 304 } },
  permission_denials: [{ tool_name: 'Bash' }],
  ...extra,
});

describe('callUsageOf', () => {
  it('counts cache reads and writes as input, as the harness path does', () => {
    assert.deepEqual(callUsageOf({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 90 }), {
      inputTokens: 1000,
      outputTokens: 5,
      totalTokens: 1005,
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: 90,
    });
    assert.equal(callUsageOf(undefined), undefined);
  });
});

describe('SdkTally', () => {
  it('counts tool calls and one usage record per model response, subagents included', () => {
    const tally = new SdkTally();
    const usage = { input_tokens: 2, output_tokens: 20, cache_read_input_tokens: 100 };
    // The SDK splits one response into several messages that repeat its usage.
    tally.add(assistant('msg_1', [{ type: 'text', text: 'Looking.' }], usage));
    const lines = tally.add(assistant('msg_1', [{ type: 'tool_use', name: 'Agent', input: { subagent_type: 'explore' } }], usage));
    tally.add(assistant('msg_2', [{ type: 'tool_use', name: 'Grep', input: { pattern: 'VERSION' } }], usage, 'toolu_1'));
    assert.equal(tally.toolCalls, 2);
    assert.equal(tally.calls.length, 2);
    assert.deepEqual(lines, [{ message: 'tool use', fields: { tool: 'Agent', agent: 'main', input: '{"subagent_type":"explore"}', bytes: 27 } }]);
    assert.equal(tally.ended, false);
  });

  it('keeps what the result reports', () => {
    const tally = new SdkTally();
    tally.add(result('success'));
    assert.equal(tally.ended, true);
    assert.deepEqual(tally.result, {
      subtype: 'success',
      numTurns: 3,
      durationMs: 3512,
      costUsd: 0.0406,
      modelUsage: { 'eu.anthropic.claude-sonnet-5-5': { inputTokens: 4, outputTokens: 304 } },
      permissionDenials: 1,
      errors: [],
    });
  });

  it("recognises the host's end markers", () => {
    const failed = new SdkTally();
    failed.add({ type: HOST_ERROR, error: 'subprocess exited' });
    assert.equal(failed.ended, true);
    const stopped = new SdkTally();
    stopped.add({ type: MAX_DURATION });
    assert.equal(stopped.ended, true);
  });

  it('ignores anything else', () => {
    const tally = new SdkTally();
    assert.deepEqual(tally.add({ type: 'system', subtype: 'init' }), []);
    assert.deepEqual(tally.add(null), []);
    assert.equal(tally.ended, false);
  });
});

describe('runtimeStop', () => {
  const tallyWith = (...messages: unknown[]) => {
    const tally = new SdkTally();
    for (const message of messages) tally.add(message);
    return tally;
  };

  it('maps the result subtypes', () => {
    assert.deepEqual(runtimeStop(tallyWith(result('success')), { state: 'finished', outcome: 'complete' }), { stopReason: 'success' });
    assert.deepEqual(runtimeStop(tallyWith(result('error_max_turns')), undefined), { stopReason: 'error_max_turns' });
    assert.deepEqual(runtimeStop(tallyWith(result('error_max_budget_usd')), undefined), { stopReason: 'error_max_budget_usd' });
    assert.deepEqual(runtimeStop(tallyWith(result('error_during_execution', { errors: ['API error 500'] })), undefined), {
      stopReason: 'error_during_execution',
      error: 'error_during_execution: API error 500',
    });
  });

  it("takes the host's time limit over the SDK's result", () => {
    const tally = tallyWith(result('error_during_execution'), { type: MAX_DURATION });
    assert.deepEqual(runtimeStop(tally, undefined), { stopReason: 'max_duration' });
    assert.deepEqual(runtimeStop(tallyWith(result('error_during_execution')), { state: 'finished', stopReason: 'max_duration' }), {
      stopReason: 'max_duration',
    });
  });

  it('fails closed when the host and the stream disagree', () => {
    assert.deepEqual(runtimeStop(tallyWith(result('success')), { state: 'finished', outcome: 'incomplete' }), {
      stopReason: 'outcome_mismatch',
      error: 'outcome_mismatch: the host reported incomplete, the stream success',
    });
    assert.equal(runtimeStop(tallyWith(result('error_max_turns')), { state: 'finished', outcome: 'complete' }).stopReason, 'outcome_mismatch');
    assert.deepEqual(runtimeStop(tallyWith(result('error_max_turns')), { state: 'finished', outcome: 'incomplete' }), { stopReason: 'error_max_turns' });
  });

  it('reports a host failure or a missing result as an error', () => {
    assert.deepEqual(runtimeStop(tallyWith({ type: HOST_ERROR, error: 'boom' }), undefined), { stopReason: 'host_error', error: 'host_error: boom' });
    assert.deepEqual(runtimeStop(new SdkTally(), { state: 'failed', error: 'boom' }), { stopReason: 'host_error', error: 'host_error: boom' });
    assert.deepEqual(runtimeStop(new SdkTally(), undefined), { stopReason: 'no_result', error: 'the run ended without a result message' });
  });
});

describe('runUsageOf', () => {
  it("takes the totals from the result's modelUsage, and the call count and sizes from the stream", () => {
    const tally = new SdkTally();
    tally.add(assistant('msg_1', [], { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 9000 }));
    tally.add(assistant('msg_2', [], { input_tokens: 6, output_tokens: 1, cache_read_input_tokens: 7000 }, 'toolu_1'));
    tally.add({
      type: 'result',
      subtype: 'success',
      modelUsage: {
        'eu.anthropic.claude-sonnet-5-5': { inputTokens: 4, outputTokens: 401, cacheReadInputTokens: 9598, cacheCreationInputTokens: 100 },
        'eu.anthropic.claude-haiku-5-5': { inputTokens: 6, outputTokens: 405, cacheReadInputTokens: 7131, cacheCreationInputTokens: 0 },
      },
    });
    assert.deepEqual(runUsageOf(tally), {
      modelCalls: 2,
      inputTokens: 16839,
      outputTokens: 806,
      totalTokens: 17645,
      cacheReadInputTokens: 16729,
      cacheWriteInputTokens: 100,
      uncachedInputTokens: 110,
      maxCallInputTokens: 9004,
      lastCallInputTokens: 7006,
    });
  });

  it('falls back to the summed calls before a result arrives', () => {
    const tally = new SdkTally();
    tally.add(assistant('msg_1', [], { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 9000 }));
    assert.equal(runUsageOf(tally).modelCalls, 1);
    assert.equal(runUsageOf(tally).inputTokens, 9004);
  });
});

describe('subagent results', () => {
  const toolResult = (toolUseResult: unknown, parent: string | null = null) => ({ type: 'user', parent_tool_use_id: parent, tool_use_result: toolUseResult });
  const usage = { input_tokens: 5, output_tokens: 50 };

  it('records a completed plan result and an explore result, with a total per type', () => {
    const tally = new SdkTally();
    tally.add(toolResult({ status: 'completed', agentId: 'a1', agentType: 'plan', totalTokens: 1000, totalDurationMs: 2000, totalToolUseCount: 4, usage }));
    tally.add(toolResult({ agentId: 'a2', agentType: 'explore', totalTokens: 300, totalDurationMs: 500, totalToolUseCount: 2, usage }));
    tally.add(toolResult({ agentId: 'a3', agentType: 'explore', totalTokens: 200, totalDurationMs: 100, totalToolUseCount: 1, usage }));
    assert.deepEqual(tally.subagentRuns[0], { agentType: 'plan', totalTokens: 1000, totalDurationMs: 2000, totalToolUseCount: 4, usage });
    assert.deepEqual(tally.subagentRuns.map((run) => run.agentType), ['plan', 'explore', 'explore']);
    assert.deepEqual(subagentsOf(tally.subagentRuns).totals, [
      { agentType: 'plan', runs: 1, totalTokens: 1000, totalDurationMs: 2000, totalToolUseCount: 4 },
      { agentType: 'explore', runs: 2, totalTokens: 500, totalDurationMs: 600, totalToolUseCount: 3 },
    ]);
  });

  it('ignores an async_launched result', () => {
    const tally = new SdkTally();
    tally.add(toolResult({ status: 'async_launched', agentId: 'a1', agentType: 'plan', description: 'x', prompt: 'y' }));
    assert.equal(tally.subagentRuns.length, 0);
  });

  it('ignores malformed results and subagents own messages without failing', () => {
    const tally = new SdkTally();
    for (const bad of [undefined, null, 'text', 7, [], {}, { agentType: 5 }, { agentType: '' }]) tally.add(toolResult(bad));
    tally.add(toolResult({ agentType: 'plan', totalTokens: 'many', usage: 'none' }));
    tally.add(toolResult({ agentType: 'plan', totalTokens: 1 }, 'toolu_1'));
    assert.deepEqual(tally.subagentRuns, [{ agentType: 'plan', totalTokens: 0, totalDurationMs: 0, totalToolUseCount: 0 }]);
  });
});
