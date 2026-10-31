import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RunEnded, RunStatus } from '@factorial/run';

import { RunTally, callUsageOf, runUsageOf, runtimeStop, subagentsOf } from './run-events.ts';

const started = {
  type: 'run.started',
  contract: 1,
  harness: { name: 'pi', version: '1.4.0' },
  role: 'builder',
  models: [{ purpose: 'main', provider: 'bedrock', id: 'eu.anthropic.claude-sonnet-5-5' }],
};

const call = (usage: Record<string, number>, agentId?: string) => ({
  type: 'model.call',
  ...(agentId ? { agentId } : {}),
  usage: { inputTokens: 0, outputTokens: 0, ...usage },
  exact: false,
});

const ended = (outcome: RunEnded['outcome'], reason: string, extra: Partial<RunEnded> = {}): RunEnded => ({ type: 'run.ended', outcome, reason, ...extra });

const status = (end: RunEnded | undefined, state: RunStatus['state'] = 'finished'): RunStatus => ({ contract: 1, state, events: 3, ...(end ? { ended: end } : {}) });

function tallyWith(...events: unknown[]): RunTally {
  const tally = new RunTally();
  for (const event of [started, ...events]) tally.add(event);
  return tally;
}

describe('callUsageOf', () => {
  it('keeps the contract inputTokens, which include cache reads and writes', () => {
    assert.deepEqual(callUsageOf({ inputTokens: 1000, outputTokens: 5, cacheReadInputTokens: 900, cacheWriteInputTokens: 90 }), {
      inputTokens: 1000,
      outputTokens: 5,
      totalTokens: 1005,
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: 90,
    });
    assert.equal(callUsageOf({ inputTokens: 10, outputTokens: 1 }).cacheReadInputTokens, 0);
  });
});

describe('RunTally', () => {
  it('counts tool calls and model calls, subagents included, and logs tool use', () => {
    const tally = new RunTally();
    tally.add(started);
    tally.add(call({ inputTokens: 102, outputTokens: 20, cacheReadInputTokens: 100 }));
    const lines = tally.add({ type: 'tool.call', callId: 'toolu_1', tool: 'Agent', input: { subagent_type: 'explore' } });
    tally.add({ type: 'tool.call', agentId: 'toolu_1', callId: 'toolu_2', tool: 'Grep', input: { pattern: 'VERSION' } });
    tally.add(call({ inputTokens: 50, outputTokens: 2 }, 'toolu_1'));
    assert.equal(tally.toolCalls, 2);
    assert.equal(tally.calls.length, 2);
    assert.deepEqual(lines, [{ message: 'tool use', fields: { tool: 'Agent', agent: 'main', input: '{"subagent_type":"explore"}', bytes: 27 } }]);
    assert.equal(tally.started?.harness.name, 'pi');
    assert.equal(tally.ended, false);
  });

  it('logs each model call with its usage, its model, the agent and the summed calls so far', () => {
    const tally = new RunTally();
    tally.add(started);
    const [first] = tally.add({ ...call({ inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 90 }), model: { provider: 'bedrock', id: 'claude' }, cost: { usd: 0.00125 } });
    const [second] = tally.add({ ...call({ inputTokens: 40, outputTokens: 4 }, 'toolu_1'), cost: { usd: 0.0005 } });
    assert.equal(first?.message, 'model call');
    assert.deepEqual(first?.fields, {
      agent: 'main',
      model: 'claude',
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadInputTokens: 90, cacheWriteInputTokens: 0 },
      costUsd: 0.0013,
      total: {
        modelCalls: 1,
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        cacheReadInputTokens: 90,
        cacheWriteInputTokens: 0,
        uncachedInputTokens: 10,
        maxCallInputTokens: 100,
        lastCallInputTokens: 100,
      },
      totalCostUsd: 0.0013,
    });
    assert.equal(second?.fields.agent, 'subagent');
    assert.equal((second?.fields.total as { modelCalls: number }).modelCalls, 2);
    assert.equal(second?.fields.totalCostUsd, 0.0018);
    assert.equal(tally.costedCalls, 2);
    // A call without a cost adds nothing to the cost.
    const [third] = tally.add(call({ inputTokens: 1, outputTokens: 1 }));
    assert.equal(third?.fields.costUsd, undefined);
    assert.equal(tally.costedCalls, 2);
  });

  it('logs a tool result cut at 4,000 characters with its size, and reasoning by its last 4,000', () => {
    const content = `${'r'.repeat(5000)}`;
    const tally = tallyWith();
    assert.deepEqual(tally.add({ type: 'tool.result', callId: 'toolu_1', isError: true, content }), [
      { message: 'tool result', fields: { callId: 'toolu_1', agent: 'main', isError: true, content: 'r'.repeat(4000), bytes: 5000 } },
    ]);
    assert.equal(tally.add({ type: 'tool.result', agentId: 'a', callId: 'toolu_2', content: 'ok' })[0]?.fields.isError, false);
    const thought = `start ${'t'.repeat(4000)}end`;
    const [line] = tally.add({ type: 'reasoning', text: thought });
    assert.equal(line?.message, 'reasoning');
    assert.equal(line?.fields.text, thought.slice(-4000));
    assert.deepEqual(tally.add({ type: 'reasoning', text: '   ' }), []);
  });

  it('ends at run.ended', () => {
    const tally = tallyWith(ended('complete', 'completed', { turns: 3, cost: { usd: 0.04, basis: 'harness-estimate' } }));
    assert.equal(tally.ended, true);
    assert.equal(tally.end?.turns, 3);
  });

  it('logs the run ended cost rounded, and leaves the event itself unrounded', () => {
    const tally = new RunTally();
    tally.add(started);
    const event = ended('complete', 'completed', { cost: { usd: 0.25970079999999995, basis: 'harness-estimate' } });
    const lines = tally.add(event);
    assert.equal(lines[0]?.fields.costUsd, 0.2597);
    assert.equal(tally.end?.cost?.usd, 0.25970079999999995);
    assert.equal(tally.add(ended('complete', 'completed'))[0]?.fields.costUsd, undefined);
  });

  it('stops reading a host whose first event is not run.started for this contract', () => {
    for (const first of [{ type: 'system', subtype: 'init' }, { ...started, contract: 2 }, null]) {
      const tally = new RunTally();
      tally.add(first);
      assert.equal(tally.ended, true);
      assert.match(tally.contractMismatch ?? '', /^contract_mismatch/);
      assert.equal(runtimeStop(tally, undefined).stopReason, 'contract_mismatch');
    }
  });

  it('counts an invalid event without reading it, and ignores types it does not know', () => {
    const tally = tallyWith({ type: 'model.call', usage: { inputTokens: -1 } }, { type: 'tool.call', tool: 'Bash' }, { type: 'budget.warning', remainingUsd: 1 });
    assert.equal(tally.invalidEvents, 2);
    assert.equal(tally.calls.length, 0);
    assert.equal(tally.toolCalls, 0);
    assert.equal(tally.ended, false);
  });
});

describe('runtimeStop', () => {
  it('takes the outcome and reason from run.ended', () => {
    assert.deepEqual(runtimeStop(tallyWith(ended('complete', 'completed')), status(ended('complete', 'completed'))), { outcome: 'complete', stopReason: 'completed' });
    assert.deepEqual(runtimeStop(tallyWith(ended('incomplete', 'max_turns')), undefined), { outcome: 'incomplete', stopReason: 'max_turns' });
    assert.deepEqual(runtimeStop(tallyWith(ended('incomplete', 'max_duration')), undefined), { outcome: 'incomplete', stopReason: 'max_duration' });
    assert.deepEqual(runtimeStop(tallyWith(ended('failed', 'harness_error', { errors: ['API error 500'] })), undefined), {
      outcome: 'failed',
      stopReason: 'harness_error',
      error: 'harness_error: API error 500',
    });
  });

  it("decides a reason it does not know by its outcome", () => {
    assert.deepEqual(runtimeStop(tallyWith(ended('incomplete', 'context_exhausted')), undefined), { outcome: 'incomplete', stopReason: 'context_exhausted' });
  });

  it('fails closed when the host and the stream disagree, or a known reason contradicts its outcome', () => {
    assert.deepEqual(runtimeStop(tallyWith(ended('complete', 'completed')), status(ended('incomplete', 'max_turns'))), {
      outcome: 'failed',
      stopReason: 'outcome_mismatch',
      error: 'outcome_mismatch: the host reported incomplete (max_turns), the stream complete (completed)',
    });
    assert.equal(runtimeStop(tallyWith(ended('incomplete', 'max_turns')), status(ended('incomplete', 'max_budget'))).stopReason, 'outcome_mismatch');
    assert.equal(runtimeStop(tallyWith(ended('complete', 'max_turns')), undefined).stopReason, 'outcome_mismatch');
  });

  it("uses the host's status when the stream lost run.ended, and fails without either", () => {
    assert.deepEqual(runtimeStop(tallyWith(), status(ended('failed', 'host_error', { errors: ['boom'] }), 'failed')), {
      outcome: 'failed',
      stopReason: 'host_error',
      error: 'host_error: boom',
    });
    assert.equal(runtimeStop(tallyWith(), status(undefined, 'failed')).stopReason, 'host_error');
    assert.deepEqual(runtimeStop(tallyWith(), undefined), { outcome: 'failed', stopReason: 'no_end', error: 'the run ended without a run.ended event' });
  });
});

describe('runUsageOf', () => {
  it("takes the totals from run.ended's models, and the call count and sizes from the calls", () => {
    const tally = tallyWith(
      call({ inputTokens: 9004, outputTokens: 1, cacheReadInputTokens: 9000 }),
      call({ inputTokens: 7006, outputTokens: 1, cacheReadInputTokens: 7000 }, 'toolu_1'),
      ended('complete', 'completed', {
        models: [
          { model: { provider: 'bedrock', id: 'eu.anthropic.claude-sonnet-5-5' }, usage: { inputTokens: 9702, outputTokens: 401, cacheReadInputTokens: 9598, cacheWriteInputTokens: 100 } },
          { model: { provider: 'bedrock', id: 'eu.anthropic.claude-haiku-5-5' }, usage: { inputTokens: 7137, outputTokens: 405, cacheReadInputTokens: 7131, cacheWriteInputTokens: 0 } },
        ],
      }),
    );
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

  it('falls back to the summed calls before run.ended, or for a provider that reports no totals', () => {
    const tally = tallyWith(call({ inputTokens: 9004, outputTokens: 1, cacheReadInputTokens: 9000 }));
    assert.equal(runUsageOf(tally).modelCalls, 1);
    assert.equal(runUsageOf(tally).inputTokens, 9004);
    tally.add(ended('complete', 'completed'));
    assert.equal(runUsageOf(tally).inputTokens, 9004);
  });
});

describe('subagent runs', () => {
  const subagentEnded = (agentId: string, agentType: string, extra: Record<string, number> = {}) => ({
    type: 'subagent.ended',
    agentId,
    agentType,
    durationMs: 2000,
    toolCalls: 4,
    finalContextTokens: 900,
    ...extra,
  });

  it("sums a subagent's tokens from its own calls, and keeps the harness's figure as its final context", () => {
    const tally = tallyWith(
      call({ inputTokens: 130, cacheReadInputTokens: 100, cacheWriteInputTokens: 20, outputTokens: 5 }, 'toolu_plan'),
      call({ inputTokens: 302, cacheReadInputTokens: 300, cacheWriteInputTokens: 0, outputTokens: 40 }, 'toolu_plan'),
      subagentEnded('toolu_plan', 'plan'),
    );
    assert.deepEqual(tally.subagentRuns, [
      {
        agentType: 'plan',
        durationMs: 2000,
        toolUseCount: 4,
        modelCalls: 2,
        inputTokens: 432,
        cacheReadInputTokens: 400,
        cacheWriteInputTokens: 20,
        outputTokensAtLeast: 45,
        finalContextTokens: 900,
      },
    ]);
  });

  it('keeps each run in order with a total per type, and counts no calls for a run whose calls were not seen', () => {
    const tally = tallyWith(
      call({ inputTokens: 100, outputTokens: 10 }, 'toolu_p'),
      subagentEnded('toolu_p', 'plan'),
      call({ inputTokens: 30, outputTokens: 3 }, 'toolu_e1'),
      subagentEnded('toolu_e1', 'explore', { durationMs: 500, toolCalls: 2 }),
      subagentEnded('toolu_e2', 'explore', { durationMs: 100, toolCalls: 1 }),
    );
    assert.deepEqual(tally.subagentRuns.map((run) => [run.agentType, run.modelCalls, run.inputTokens]), [
      ['plan', 1, 100],
      ['explore', 1, 30],
      ['explore', 0, 0],
    ]);
    assert.deepEqual(subagentsOf(tally.subagentRuns).totals[1], {
      agentType: 'explore',
      runs: 2,
      durationMs: 600,
      toolUseCount: 3,
      modelCalls: 1,
      inputTokens: 30,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokensAtLeast: 3,
    });
  });
});
