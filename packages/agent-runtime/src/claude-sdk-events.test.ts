import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateRunEvent, type RunEvent } from '@factorial/run';

import { ClaudeSdkEvents, claudeRunEvents, runEndedOf, runStarted, sdkVersion, usageOf } from './claude-sdk-events.ts';
import { readConfig } from './config.ts';

const env = {
  FACTORIAL_ROLE: 'builder',
  FACTORIAL_MODEL: 'eu.anthropic.claude-sonnet-5-5',
  FACTORIAL_EXPLORE_MODEL: 'eu.anthropic.claude-haiku-5-5',
  FACTORIAL_BACKGROUND_MODEL: 'eu.anthropic.claude-haiku-5-5',
  FACTORIAL_MAX_TURNS: '150',
  FACTORIAL_RUN_CONTRACT: '1',
  FACTORIAL_MAX_BUDGET_USD: '5',
  FACTORIAL_MAX_DURATION_SECONDS: '6600',
  AWS_REGION: 'eu-west-1',
};

const assistant = (id: string, content: unknown[], usage: object, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { id, model: 'claude-sonnet-5-5', content, usage },
});

const toolResult = (toolUseId: string, content: unknown, toolUseResult?: unknown, parent: string | null = null) => ({
  type: 'user',
  parent_tool_use_id: parent,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  ...(toolUseResult === undefined ? {} : { tool_use_result: toolUseResult }),
});

const result = (subtype: string, extra: object = {}) => ({
  type: 'result',
  subtype,
  num_turns: 3,
  duration_ms: 3512,
  total_cost_usd: 0.0406,
  modelUsage: {
    'eu.anthropic.claude-sonnet-5-5': { inputTokens: 4, outputTokens: 401, cacheReadInputTokens: 9598, cacheCreationInputTokens: 100, costUSD: 0.04, thinkingTokens: 50 },
  },
  permission_denials: [{ tool_name: 'Bash' }],
  errors: [],
  ...extra,
});

/** Translates the messages in order and checks every event meets the contract. */
function translate(...messages: unknown[]): RunEvent[] {
  const adapter = new ClaudeSdkEvents();
  const events = messages.flatMap((message) => adapter.translate(message));
  for (const event of events) {
    const valid = validateRunEvent(event);
    assert.ok(valid.ok, `${JSON.stringify(event)}: ${valid.ok ? '' : valid.errors.join('; ')}`);
  }
  return events;
}

describe('runStarted', () => {
  it('names the harness, the role, every model by purpose and the tools', () => {
    const event = runStarted(readConfig(env), ['Bash', 'Read'], '0.3.309');
    assert.deepEqual(event, {
      type: 'run.started',
      contract: 1,
      harness: { name: 'claude-agent-sdk', version: '0.3.309' },
      role: 'builder',
      models: [
        { purpose: 'main', provider: 'bedrock', id: 'eu.anthropic.claude-sonnet-5-5' },
        { purpose: 'explore', provider: 'bedrock', id: 'eu.anthropic.claude-haiku-5-5' },
        { purpose: 'background', provider: 'bedrock', id: 'eu.anthropic.claude-haiku-5-5' },
      ],
      tools: ['Bash', 'Read'],
    });
    assert.ok(validateRunEvent(event).ok);
  });

  it("reads the installed SDK's version", () => {
    assert.match(sdkVersion() ?? '', /^\d+\.\d+\.\d+/);
  });
});

describe('usageOf', () => {
  it('counts cache reads and writes as input, as the contract does', () => {
    assert.deepEqual(usageOf({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 90 }), {
      inputTokens: 1000,
      outputTokens: 5,
      cacheReadInputTokens: 900,
      cacheWriteInputTokens: 90,
    });
  });
});

describe('ClaudeSdkEvents', () => {
  it('counts one model call per response, however the SDK splits it', () => {
    const usage = { input_tokens: 2, output_tokens: 20, cache_read_input_tokens: 100 };
    const events = translate(
      assistant('msg_1', [{ type: 'thinking', thinking: 'Where is it?' }], usage),
      assistant('msg_1', [{ type: 'text', text: 'Looking.' }], usage),
      assistant('msg_1', [{ type: 'tool_use', id: 'toolu_g', name: 'Grep', input: { pattern: 'VERSION' } }], usage),
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ['model.call', 'reasoning', 'text', 'tool.call'],
    );
    assert.deepEqual(events[0], {
      type: 'model.call',
      model: { provider: 'bedrock', id: 'claude-sonnet-5-5' },
      usage: { inputTokens: 102, outputTokens: 20, cacheReadInputTokens: 100, cacheWriteInputTokens: 0 },
      exact: false,
    });
    assert.deepEqual(events[3], { type: 'tool.call', callId: 'toolu_g', tool: 'Grep', input: { pattern: 'VERSION' } });
  });

  it("follows a subagent from its Agent call to its result, and puts its own events under its id", () => {
    const events = translate(
      assistant('msg_1', [{ type: 'tool_use', id: 'toolu_plan', name: 'Agent', input: { subagent_type: 'plan', prompt: 'Plan it.' } }], { input_tokens: 5, output_tokens: 9 }),
      assistant('msg_2', [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/workspace/a' } }], { input_tokens: 3, output_tokens: 4 }, 'toolu_plan'),
      toolResult('toolu_read', [{ type: 'text', text: 'contents' }], undefined, 'toolu_plan'),
      toolResult('toolu_plan', 'Wrote the plan.', { status: 'completed', agentType: 'plan', totalDurationMs: 2000, totalToolUseCount: 4, totalTokens: 900 }),
    );
    assert.deepEqual(
      events.filter((event) => event.type.startsWith('subagent.')),
      [
        { type: 'subagent.started', agentId: 'toolu_plan', agentType: 'plan' },
        { type: 'subagent.ended', agentId: 'toolu_plan', agentType: 'plan', durationMs: 2000, toolCalls: 4, finalContextTokens: 900 },
      ],
    );
    assert.deepEqual(events.find((event) => event.type === 'model.call' && event.agentId === 'toolu_plan')?.type, 'model.call');
    assert.deepEqual(events.filter((event) => event.type === 'tool.result'), [
      { type: 'tool.result', agentId: 'toolu_plan', callId: 'toolu_read', content: 'contents' },
      { type: 'tool.result', callId: 'toolu_plan', content: 'Wrote the plan.' },
    ]);
  });

  it('ends no subagent on an async launch, and none for an ordinary tool', () => {
    const events = translate(
      assistant('msg_1', [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { subagent_type: 'explore' } }], { input_tokens: 1, output_tokens: 1 }),
      toolResult('toolu_a', 'launched', { status: 'async_launched', agentType: 'explore' }),
      toolResult('toolu_b', 'ok', { status: 'completed', agentType: 'plan' }),
    );
    assert.equal(events.filter((event) => event.type === 'subagent.ended').length, 0);
  });

  it('marks a failed tool result and keeps non-text blocks as placeholders', () => {
    const [event] = translate(toolResult('toolu_x', [{ type: 'text', text: 'denied' }, { type: 'image' }]));
    assert.equal(event?.type, 'tool.result');
    const failed = translate({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_y', is_error: true, content: 'boom' }] } });
    assert.deepEqual(failed, [{ type: 'tool.result', callId: 'toolu_y', isError: true, content: 'boom' }]);
    assert.deepEqual(event, { type: 'tool.result', callId: 'toolu_x', content: 'denied\n[image]' });
  });

  it('maps compaction and retries, and passes any other message through for the transcript', () => {
    const events = translate(
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 180000, post_tokens: 22000 } },
      { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 800, error_status: 529, error: 'overloaded' },
      { type: 'system', subtype: 'init', model: 'eu.anthropic.claude-sonnet-5-5' },
      { type: 'user', message: { content: 'The Stop hook sent you back.' } },
      null,
    );
    assert.deepEqual(events, [
      { type: 'context.compacted', trigger: 'auto', tokensBefore: 180000, tokensAfter: 22000 },
      { type: 'model.retry', attempt: 2, maxRetries: 10, delayMs: 800, status: 529, error: 'overloaded' },
      { type: 'harness', name: 'claude-agent-sdk', message: { type: 'system', subtype: 'init', model: 'eu.anthropic.claude-sonnet-5-5' } },
      { type: 'harness', name: 'claude-agent-sdk', message: { type: 'user', message: { content: 'The Stop hook sent you back.' } } },
    ]);
  });
});

describe('runEndedOf', () => {
  it('maps every result subtype to an outcome and a reason, keeping the subtype as the detail', () => {
    const ending = (subtype: string) => {
      const { outcome, reason, detail } = runEndedOf(result(subtype));
      return [outcome, reason, detail];
    };
    assert.deepEqual(ending('success'), ['complete', 'completed', 'success']);
    assert.deepEqual(ending('error_max_turns'), ['incomplete', 'max_turns', 'error_max_turns']);
    assert.deepEqual(ending('error_max_budget_usd'), ['incomplete', 'max_budget', 'error_max_budget_usd']);
    assert.deepEqual(ending('error_during_execution'), ['failed', 'harness_error', 'error_during_execution']);
    assert.deepEqual(ending('error_max_structured_output_retries'), ['failed', 'harness_error', 'error_max_structured_output_retries']);
    assert.deepEqual(ending('error_from_a_newer_sdk'), ['failed', 'harness_error', 'error_from_a_newer_sdk']);
  });

  it("keeps the result's turns, cost, per-model totals and denials", () => {
    const [ended] = translate(result('error_during_execution', { errors: ['API error 500'] }));
    assert.deepEqual(ended, {
      type: 'run.ended',
      outcome: 'failed',
      reason: 'harness_error',
      detail: 'error_during_execution',
      errors: ['API error 500'],
      turns: 3,
      durationMs: 3512,
      cost: { usd: 0.0406, basis: 'harness-estimate' },
      models: [
        {
          model: { provider: 'bedrock', id: 'eu.anthropic.claude-sonnet-5-5' },
          usage: { inputTokens: 9702, outputTokens: 401, cacheReadInputTokens: 9598, cacheWriteInputTokens: 100, reasoningTokens: 50 },
          costUsd: 0.04,
        },
      ],
      deniedToolCalls: 1,
    });
  });
});

describe('claudeRunEvents', () => {
  it('starts with run.started, before the SDK sends anything', async () => {
    const started = runStarted(readConfig(env), [], '0.3.309');
    const events: RunEvent[] = [];
    for await (const event of claudeRunEvents(started, (async function* () {
      yield result('success');
    })())) events.push(event);
    assert.deepEqual(events.map((event) => event.type), ['run.started', 'run.ended']);
  });
});
