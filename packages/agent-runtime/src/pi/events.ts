/**
 * pi's session events as run events (contracts/run/v1/), for the main session
 * and each subagent's, which carry its agentId. The only place pi's event
 * shapes are read. pi reports each model call once, at message_end, with its
 * final usage, so a call's figures are exact; its input count excludes cache
 * reads and writes, which the contract's inputTokens includes. Each call
 * carries pi's cost estimate at the provider's list prices and its measured
 * duration (`durationMs`, request to end of response); the totals per
 * model and the cost become run.ended's figures.
 */
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ModelTotal, RunEnded, RunEvent, RunStarted, TokenUsage } from '@factorial/run';
import { RUN_CONTRACT } from '@factorial/run';

import type { Config } from '../config.ts';

export const HARNESS = 'pi';
/** How pi reaches the model: its amazon-bedrock provider, through the AWS credential chain. */
export const PROVIDER = 'bedrock';

export function runStarted(config: Config, tools: readonly string[], version: string | undefined): RunStarted {
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

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

export function usageOf(usage: Usage | undefined): TokenUsage {
  const cacheRead = count(usage?.cacheRead);
  const cacheWrite = count(usage?.cacheWrite);
  const reasoning = count(usage?.reasoning);
  return {
    inputTokens: count(usage?.input) + cacheRead + cacheWrite,
    outputTokens: count(usage?.output),
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** How long pi measured the call, request to end of response (#59); none for a message it did not see start. */
export function durationOf(message: Pick<AssistantMessage, 'durationMs'>): { durationMs?: number } {
  const ms = message.durationMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? { durationMs: Math.round(ms) } : {};
}

/** pi's estimate for one call at the provider's list prices, for the live view (#194); none when pi has no price. */
export function costOf(usage: Usage | undefined): { cost?: { usd: number } } {
  const usd = usage?.cost?.total;
  return typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? { cost: { usd } } : {};
}

function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return typeof result === 'string' ? result : '';
  return (content as { type?: unknown; text?: unknown }[])
    .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : block?.type ? `[${String(block.type)}]` : ''))
    .filter((part) => part.length > 0)
    .join('\n');
}

export class PiEvents {
  private readonly totals = new Map<string, { usage: TokenUsage; costUsd: number }>();
  costUsd = 0;
  deniedToolCalls = 0;
  /** The last call's input per agent: a subagent's final context size. */
  readonly lastInput = new Map<string, number>();

  private readonly emit: (event: RunEvent) => void;

  constructor(emit: (event: RunEvent) => void) {
    this.emit = emit;
  }

  /** One model call: its usage and what it said. `agentId` is absent for the main session. */
  modelCall(message: AssistantMessage, agentId?: string): void {
    const agent = agentId ? { agentId } : {};
    const model = { provider: PROVIDER, id: message.model };
    const usage = usageOf(message.usage);
    this.emit({ type: 'model.call', ...agent, model, usage, exact: true, ...durationOf(message), ...costOf(message.usage) });
    this.add(message.model, usage, message.usage?.cost?.total);
    this.lastInput.set(agentId ?? '', usage.inputTokens);
    for (const block of message.content ?? []) {
      if (block.type === 'text' && block.text.trim()) this.emit({ type: 'text', ...agent, model, text: block.text });
      else if (block.type === 'thinking' && !block.redacted && block.thinking.trim()) this.emit({ type: 'reasoning', ...agent, model, text: block.thinking });
    }
  }

  /** A model call outside a session (the fetch tool's answer), counted like any other. */
  sideCall(message: AssistantMessage, agentId?: string): void {
    const usage = usageOf(message.usage);
    this.emit({ type: 'model.call', ...(agentId ? { agentId } : {}), model: { provider: PROVIDER, id: message.model }, usage, exact: true, ...durationOf(message), ...costOf(message.usage) });
    this.add(message.model, usage, message.usage?.cost?.total);
  }

  private add(model: string, usage: TokenUsage, cost: number | undefined): void {
    const total = this.totals.get(model) ?? { usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }, costUsd: 0 };
    const sum = (a: number | undefined, b: number | undefined) => (a ?? 0) + (b ?? 0);
    total.usage = {
      inputTokens: sum(total.usage.inputTokens, usage.inputTokens),
      outputTokens: sum(total.usage.outputTokens, usage.outputTokens),
      cacheReadInputTokens: sum(total.usage.cacheReadInputTokens, usage.cacheReadInputTokens),
      cacheWriteInputTokens: sum(total.usage.cacheWriteInputTokens, usage.cacheWriteInputTokens),
      ...(usage.reasoningTokens || total.usage.reasoningTokens ? { reasoningTokens: sum(total.usage.reasoningTokens, usage.reasoningTokens) } : {}),
    };
    const usd = typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : 0;
    total.costUsd += usd;
    this.costUsd += usd;
    this.totals.set(model, total);
  }

  /** One session event, from the main session or a subagent's. */
  session(event: AgentSessionEvent, agentId?: string): void {
    const agent = agentId ? { agentId } : {};
    switch (event.type) {
      case 'message_end':
        if (event.message.role === 'assistant') this.modelCall(event.message as AssistantMessage, agentId);
        break;
      case 'tool_execution_start':
        this.emit({ type: 'tool.call', ...agent, callId: event.toolCallId, tool: event.toolName, input: event.args ?? {} });
        break;
      case 'tool_execution_end':
        this.emit({ type: 'tool.result', ...agent, callId: event.toolCallId, ...(event.isError ? { isError: true } : {}), content: resultText(event.result) });
        break;
      case 'compaction_end':
        if (event.result) {
          this.emit({
            type: 'context.compacted',
            ...agent,
            trigger: event.reason === 'manual' ? 'manual' : 'auto',
            tokensBefore: count(event.result.tokensBefore),
            ...(event.result.estimatedTokensAfter ? { tokensAfter: count(event.result.estimatedTokensAfter) } : {}),
          });
          if (event.result.usage) this.add('compaction', usageOf(event.result.usage), event.result.usage.cost?.total);
        }
        break;
      case 'auto_retry_start':
        this.emit({ type: 'model.retry', attempt: Math.max(1, count(event.attempt)), maxRetries: count(event.maxAttempts), delayMs: count(event.delayMs), status: null, error: event.errorMessage });
        break;
    }
  }

  ended(ending: Pick<RunEnded, 'outcome' | 'reason'> & { detail?: string; errors?: string[]; turns: number; durationMs: number }): RunEnded {
    const models: ModelTotal[] = [...this.totals].map(([id, { usage, costUsd }]) => ({
      model: { provider: PROVIDER, id },
      usage,
      ...(costUsd > 0 ? { costUsd } : {}),
    }));
    return {
      type: 'run.ended',
      outcome: ending.outcome,
      reason: ending.reason,
      ...(ending.detail ? { detail: ending.detail.slice(0, 200) } : {}),
      ...(ending.errors && ending.errors.length > 0 ? { errors: ending.errors.slice(0, 50) } : {}),
      turns: count(ending.turns),
      durationMs: count(ending.durationMs),
      cost: { usd: this.costUsd, basis: 'harness-estimate' },
      ...(models.length > 0 ? { models } : {}),
      deniedToolCalls: this.deniedToolCalls,
    };
  }
}
