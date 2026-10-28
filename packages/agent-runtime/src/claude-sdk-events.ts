/**
 * The Claude Agent SDK's messages as run events (contracts/run/v1/). This is
 * the only place the SDK's message shapes are read: the invoker sees run
 * events, so replacing the harness or the model's provider replaces this
 * adapter and leaves the invoker as it is.
 *
 * The SDK splits one model response into several messages that repeat its
 * usage, so each call is counted once, by message id. A streamed message
 * carries its usage from the start of the response, so a call's output tokens
 * are a lower bound (`exact: false`); the result's per-model totals are
 * complete and become run.ended's `models`. Anthropic counts input_tokens
 * without cache reads and writes; the contract's inputTokens includes them.
 *
 * A subagent is the Agent tool's call: its id is the call's id, which the
 * SDK puts on the subagent's own messages as parent_tool_use_id. Messages
 * with no event of their own pass through as `harness` events for the
 * transcript.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ModelTotal, RunEnded, RunEvent, RunStarted, TokenUsage } from '@factorial/run';
import { RUN_CONTRACT } from '@factorial/run';

import type { Config } from './config.ts';

export const HARNESS = 'claude-agent-sdk';
/** How the SDK reaches the model (environment.ts sets CLAUDE_CODE_USE_BEDROCK). */
export const PROVIDER = 'bedrock';
/** The SDK's tool for starting a subagent, and its name before SDK 0.2. */
const AGENT_TOOLS = new Set(['Agent', 'Task']);

/**
 * The installed SDK's version; its package exports no package.json, so it is
 * read beside the entry point. Resolved through import.meta, not
 * createRequire: the host bundle's banner already declares createRequire, and
 * a second import of it made host.mjs fail to load (2026-10-28).
 */
export function sdkVersion(): string | undefined {
  try {
    const entry = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
    return (JSON.parse(readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** The run's first event: the harness, the role and the models the Runtime version names. */
export function runStarted(config: Config, tools: readonly string[], version = sdkVersion()): RunStarted {
  const model = (purpose: string, id: string) => ({ purpose, provider: PROVIDER, id });
  return {
    type: 'run.started',
    contract: RUN_CONTRACT,
    harness: { name: HARNESS, ...(version ? { version } : {}) },
    role: config.role,
    models: [
      model('main', config.model),
      ...(config.exploreModel ? [model('explore', config.exploreModel)] : []),
      model('background', config.backgroundModel),
    ],
    tools: [...tools],
  };
}

interface AnthropicUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

interface Block {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  text?: unknown;
  thinking?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  content?: unknown;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

/** One call's usage in the contract's terms: cache reads and writes inside inputTokens. */
export function usageOf(usage: AnthropicUsage): TokenUsage {
  const cacheRead = count(usage.cache_read_input_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens);
  return {
    inputTokens: count(usage.input_tokens) + cacheRead + cacheWrite,
    outputTokens: count(usage.output_tokens),
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
  };
}

/** A tool result's text: the SDK gives a string or a list of blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : block?.type ? `[${String(block.type)}]` : ''))
    .filter((part) => part.length > 0)
    .join('\n');
}

/** How a result subtype ends the run. */
const ENDINGS: Record<string, Pick<RunEnded, 'outcome' | 'reason'>> = {
  success: { outcome: 'complete', reason: 'completed' },
  error_max_turns: { outcome: 'incomplete', reason: 'max_turns' },
  error_max_budget_usd: { outcome: 'incomplete', reason: 'max_budget' },
  error_during_execution: { outcome: 'failed', reason: 'harness_error' },
  error_max_structured_output_retries: { outcome: 'failed', reason: 'harness_error' },
};

/** The result message as run.ended. An unknown subtype fails the run rather than guessing. */
export function runEndedOf(result: Record<string, unknown>): RunEnded {
  const subtype = String(result.subtype);
  const ending = ENDINGS[subtype] ?? { outcome: 'failed', reason: 'harness_error' };
  const models: ModelTotal[] = Object.entries(record(result.modelUsage)).map(([id, value]) => {
    const totals = record(value);
    const usage = usageOf({
      input_tokens: totals.inputTokens,
      output_tokens: totals.outputTokens,
      cache_read_input_tokens: totals.cacheReadInputTokens,
      cache_creation_input_tokens: totals.cacheCreationInputTokens,
    });
    const reasoning = count(totals.thinkingTokens);
    return {
      model: { provider: PROVIDER, id },
      usage: reasoning > 0 ? { ...usage, reasoningTokens: reasoning } : usage,
      ...(typeof totals.costUSD === 'number' && totals.costUSD >= 0 ? { costUsd: totals.costUSD } : {}),
    };
  });
  const errors = Array.isArray(result.errors) ? result.errors.map(String).slice(0, 50) : [];
  return {
    type: 'run.ended',
    ...ending,
    detail: subtype.slice(0, 200),
    ...(errors.length > 0 ? { errors } : {}),
    ...(typeof result.num_turns === 'number' ? { turns: count(result.num_turns) } : {}),
    ...(typeof result.duration_ms === 'number' ? { durationMs: count(result.duration_ms) } : {}),
    ...(typeof result.total_cost_usd === 'number' && result.total_cost_usd >= 0
      ? { cost: { usd: result.total_cost_usd, basis: 'harness-estimate' as const } }
      : {}),
    ...(models.length > 0 ? { models } : {}),
    deniedToolCalls: Array.isArray(result.permission_denials) ? result.permission_denials.length : 0,
  };
}

export class ClaudeSdkEvents {
  /** Responses already counted, by message id. */
  private readonly counted = new Set<string>();
  /** Started subagents' types, by agent id. */
  private readonly subagents = new Map<string, string>();

  /** One SDK message as the run events it carries. */
  translate(message: unknown): RunEvent[] {
    const fields = record(message);
    const agentId = text(fields.parent_tool_use_id);
    const agent = agentId ? { agentId } : {};
    switch (fields.type) {
      case 'assistant':
        return this.assistant(record(fields.message), agent);
      case 'user':
        return this.user(fields, agent);
      case 'result':
        return [runEndedOf(fields)];
      case 'system':
        if (fields.subtype === 'compact_boundary') {
          const meta = record(fields.compact_metadata);
          return [
            {
              type: 'context.compacted',
              ...agent,
              trigger: meta.trigger === 'manual' ? 'manual' : 'auto',
              ...(typeof meta.pre_tokens === 'number' ? { tokensBefore: count(meta.pre_tokens) } : {}),
              ...(typeof meta.post_tokens === 'number' ? { tokensAfter: count(meta.post_tokens) } : {}),
            },
          ];
        }
        if (fields.subtype === 'api_retry') {
          return [
            {
              type: 'model.retry',
              attempt: Math.max(1, count(fields.attempt)),
              ...(typeof fields.max_retries === 'number' ? { maxRetries: count(fields.max_retries) } : {}),
              ...(typeof fields.retry_delay_ms === 'number' ? { delayMs: count(fields.retry_delay_ms) } : {}),
              status: typeof fields.error_status === 'number' ? Math.floor(fields.error_status) : null,
              ...(fields.error !== undefined ? { error: String(fields.error) } : {}),
            },
          ];
        }
        return [this.native(message)];
      default:
        return message === null || typeof message !== 'object' ? [] : [this.native(message)];
    }
  }

  private native(message: unknown): RunEvent {
    return { type: 'harness', name: HARNESS, message };
  }

  private assistant(inner: Record<string, unknown>, agent: { agentId?: string }): RunEvent[] {
    const events: RunEvent[] = [];
    const id = text(inner.model);
    const model = id ? { model: { provider: PROVIDER, id } } : {};
    const messageId = text(inner.id);
    if (messageId && !this.counted.has(messageId) && typeof inner.usage === 'object' && inner.usage !== null) {
      this.counted.add(messageId);
      events.push({ type: 'model.call', ...agent, ...model, usage: usageOf(inner.usage as AnthropicUsage), exact: false });
    }
    const content = Array.isArray(inner.content) ? (inner.content as Block[]) : [];
    for (const [index, block] of content.entries()) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        events.push({ type: 'text', ...agent, ...model, text: block.text });
      } else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
        events.push({ type: 'reasoning', ...agent, ...model, text: block.thinking });
      } else if (block?.type === 'tool_use') {
        const callId = text(block.id) ?? `${messageId ?? 'call'}-${index}`;
        const tool = text(block.name) ?? 'unknown';
        events.push({ type: 'tool.call', ...agent, callId, tool, input: block.input ?? {} });
        if (AGENT_TOOLS.has(tool)) {
          const agentType = text(record(block.input).subagent_type) ?? 'general-purpose';
          this.subagents.set(callId, agentType);
          events.push({ type: 'subagent.started', agentId: callId, agentType, ...(agent.agentId ? { parentAgentId: agent.agentId } : {}) });
        }
      }
    }
    return events;
  }

  private user(fields: Record<string, unknown>, agent: { agentId?: string }): RunEvent[] {
    const content = record(fields.message).content;
    const results = Array.isArray(content) ? (content as Block[]).filter((block) => block?.type === 'tool_result') : [];
    if (results.length === 0) return [this.native(fields)];
    const events: RunEvent[] = [];
    for (const block of results) {
      const callId = text(block.tool_use_id) ?? 'unknown';
      const ended = this.subagentEnded(callId, fields.tool_use_result);
      if (ended) events.push(ended);
      events.push({ type: 'tool.result', ...agent, callId, ...(block.is_error === true ? { isError: true } : {}), content: resultText(block.content) });
    }
    return events;
  }

  /** A finished subagent, from the Agent tool's structured result; nothing for an async launch or a malformed value. */
  private subagentEnded(callId: string, result: unknown): RunEvent | undefined {
    const started = this.subagents.get(callId);
    if (started === undefined) return undefined;
    const r = record(result);
    if (r.status === 'async_launched') return undefined;
    this.subagents.delete(callId);
    return {
      type: 'subagent.ended',
      agentId: callId,
      agentType: text(r.agentType) ?? started,
      durationMs: count(r.totalDurationMs),
      toolCalls: count(r.totalToolUseCount),
      finalContextTokens: count(r.totalTokens),
    };
  }
}

/** The run's events: run.started, then each SDK message's. */
export async function* claudeRunEvents(started: RunStarted, messages: AsyncIterable<unknown>): AsyncGenerator<RunEvent> {
  yield started;
  const adapter = new ClaudeSdkEvents();
  for await (const message of messages) yield* adapter.translate(message);
}
