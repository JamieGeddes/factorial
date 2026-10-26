/**
 * What the invoker reads from a Claude Agent SDK run on an AgentCore Runtime
 * (packages/agent-runtime): the SDK's messages, numbered by the host, plus the
 * host's own end markers. The tally keeps what the harness path keeps from
 * its stream events (tool calls, per-call usage, the stop reason, an error)
 * and adds what only the SDK reports: the result's cost estimate, per-model
 * usage including subagents, turns and permission denials.
 */
import { addCallUsage, emptyRunUsage, type CallUsage, type RunUsage } from './usage.ts';

/** Messages the host adds to the stream (packages/agent-runtime/src/run.ts). */
export const HOST_ERROR = 'factorial_host_error';
export const MAX_DURATION = 'factorial_max_duration';

/** Result subtypes that end a run as a failure rather than an incomplete round. */
const FAILED_SUBTYPES = new Set(['error_during_execution', 'error_max_structured_output_retries']);

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ContentBlock {
  type?: string;
  name?: string;
  text?: string;
  input?: unknown;
}

export interface SdkResult {
  subtype: string;
  numTurns?: number;
  durationMs?: number;
  costUsd?: number;
  modelUsage?: Record<string, unknown>;
  permissionDenials: number;
  errors: string[];
}

/** What the host's `status` action returns (packages/agent-runtime/src/run.ts). */
export interface HostStatus {
  state?: string;
  outcome?: string;
  stopReason?: string;
  error?: string;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/**
 * One model call's usage in the harness path's shape. Anthropic reports
 * input_tokens excluding cache reads and writes; the harness's inputTokens
 * includes them, so they are added back to keep the two comparable.
 */
export function callUsageOf(usage: AnthropicUsage | undefined): CallUsage | undefined {
  if (!usage) return undefined;
  const cacheRead = count(usage.cache_read_input_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens);
  const input = count(usage.input_tokens) + cacheRead + cacheWrite;
  const output = count(usage.output_tokens);
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
  };
}

/**
 * One finished subagent run. Duration and tool calls are the SDK's totals
 * from the Agent tool's result. Its token figures are not: on #140,
 * `totalTokens` and `usage` were the subagent's last model call (25,735
 * tokens, its final context), against 59,372 input tokens over its four
 * calls. So the tokens here are summed from the subagent's own streamed
 * calls, matched to the Agent call by `parent_tool_use_id`. Input and cache
 * tokens are exact; a streamed message counts output from the start of its
 * response (see runUsageOf), so output is a lower bound. The SDK's figure is
 * kept as `finalContextTokens`.
 */
export interface SubagentRun {
  agentType: string;
  durationMs: number;
  toolUseCount: number;
  modelCalls: number;
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokensAtLeast: number;
  finalContextTokens: number;
}

export type SubagentTotal = Omit<SubagentRun, 'finalContextTokens'> & { runs: number };

/** A completed Agent result with its calls' usage, or undefined for anything else (async launches, malformed values). */
function subagentRunOf(result: unknown, calls: RunUsage | undefined): SubagentRun | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const r = result as Record<string, unknown>;
  if (r.status === 'async_launched') return undefined;
  if (typeof r.agentType !== 'string' || r.agentType === '') return undefined;
  const usage = calls ?? emptyRunUsage();
  return {
    agentType: r.agentType,
    durationMs: count(r.totalDurationMs),
    toolUseCount: count(r.totalToolUseCount),
    modelCalls: usage.modelCalls,
    inputTokens: usage.inputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    outputTokensAtLeast: usage.outputTokens,
    finalContextTokens: count(r.totalTokens),
  };
}

const SUMMED = ['durationMs', 'toolUseCount', 'modelCalls', 'inputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens', 'outputTokensAtLeast'] as const;

/** The runs in order, and a total per agent type. */
export function subagentsOf(runs: SubagentRun[]): { runs: SubagentRun[]; totals: SubagentTotal[] } {
  const byType = new Map<string, SubagentTotal>();
  for (const run of runs) {
    const total = byType.get(run.agentType) ?? { agentType: run.agentType, runs: 0, ...Object.fromEntries(SUMMED.map((field) => [field, 0])) } as SubagentTotal;
    total.runs += 1;
    for (const field of SUMMED) total[field] += run[field];
    byType.set(run.agentType, total);
  }
  return { runs, totals: [...byType.values()] };
}

export interface LogLine {
  message: string;
  fields: Record<string, unknown>;
}

export class SdkTally {
  toolCalls = 0;
  calls: CallUsage[] = [];
  result: SdkResult | undefined;
  hostError: string | undefined;
  maxDuration = false;
  subagentRuns: SubagentRun[] = [];
  /** The SDK repeats an API response's usage on every message it splits it into. */
  private readonly countedMessages = new Set<string>();
  /** Each subagent's model calls so far, by the id of the Agent call that started it. */
  private readonly subagentCalls = new Map<string, RunUsage>();

  /** Takes one message and returns the log lines it is worth. */
  add(message: unknown): LogLine[] {
    const lines: LogLine[] = [];
    if (typeof message !== 'object' || message === null) return lines;
    const fields = message as Record<string, unknown>;
    switch (fields.type) {
      case 'assistant': {
        const inner = (fields.message ?? {}) as { id?: string; model?: string; content?: ContentBlock[]; usage?: AnthropicUsage };
        const agent = typeof fields.parent_tool_use_id === 'string' ? 'subagent' : 'main';
        if (inner.id && !this.countedMessages.has(inner.id)) {
          this.countedMessages.add(inner.id);
          const call = callUsageOf(inner.usage);
          if (call) this.calls.push(call);
          const parent = fields.parent_tool_use_id;
          if (call && typeof parent === 'string') this.subagentCalls.set(parent, addCallUsage(this.subagentCalls.get(parent) ?? emptyRunUsage(), call));
        }
        for (const block of inner.content ?? []) {
          if (block.type === 'tool_use') {
            this.toolCalls += 1;
            const input = JSON.stringify(block.input ?? {});
            lines.push({ message: 'tool use', fields: { tool: block.name, agent, input: input.slice(0, 4000), bytes: Buffer.byteLength(input) } });
          } else if (block.type === 'text' && block.text?.trim()) {
            lines.push({ message: 'assistant text', fields: { agent, model: inner.model, text: block.text.slice(-4000) } });
          }
        }
        break;
      }
      case 'user': {
        if (fields.parent_tool_use_id) break;
        const content = (fields.message as { content?: unknown } | undefined)?.content;
        const block = Array.isArray(content) ? (content as { type?: unknown; tool_use_id?: unknown }[]).find((b) => b?.type === 'tool_result') : undefined;
        const toolUseId = typeof block?.tool_use_id === 'string' ? block.tool_use_id : undefined;
        const run = subagentRunOf(fields.tool_use_result, toolUseId === undefined ? undefined : this.subagentCalls.get(toolUseId));
        if (run) this.subagentRuns.push(run);
        break;
      }
      case 'result': {
        this.result = {
          subtype: String(fields.subtype),
          ...(typeof fields.num_turns === 'number' ? { numTurns: fields.num_turns } : {}),
          ...(typeof fields.duration_ms === 'number' ? { durationMs: fields.duration_ms } : {}),
          ...(typeof fields.total_cost_usd === 'number' ? { costUsd: fields.total_cost_usd } : {}),
          ...(fields.modelUsage && typeof fields.modelUsage === 'object' ? { modelUsage: fields.modelUsage as Record<string, unknown> } : {}),
          permissionDenials: Array.isArray(fields.permission_denials) ? fields.permission_denials.length : 0,
          errors: Array.isArray(fields.errors) ? fields.errors.map(String) : [],
        };
        lines.push({ message: 'sdk result', fields: { subtype: this.result.subtype, numTurns: this.result.numTurns, costUsd: this.result.costUsd } });
        break;
      }
      case HOST_ERROR:
        this.hostError = String(fields.error ?? 'unknown host error');
        lines.push({ message: 'host error', fields: { error: this.hostError } });
        break;
      case MAX_DURATION:
        this.maxDuration = true;
        lines.push({ message: 'run stopped at its time limit', fields: {} });
        break;
    }
    return lines;
  }

  /** Whether the run has ended: a result or one of the host's end markers has arrived. */
  get ended(): boolean {
    return this.result !== undefined || this.hostError !== undefined || this.maxDuration;
  }
}

/** How a stop reason counts, in the host's terms (packages/agent-runtime/src/outcome.ts). */
function outcomeOfStop(stopReason: string, error: string | undefined): string {
  if (error) return 'failed';
  return stopReason === 'success' ? 'complete' : 'incomplete';
}

/**
 * The stop reason and error for the ledger and usage.json. `success` is
 * complete; a turn, budget or time limit is incomplete (the rounds path);
 * anything else is an error. The streamed messages and the host's status come
 * from the same root-owned process, which the model cannot reach, but they
 * are read separately: when both are available and they disagree, the run
 * ends as an error rather than trusting either.
 */
export function runtimeStop(tally: SdkTally, status: HostStatus | undefined): { stopReason: string; error?: string } {
  const stop = streamStop(tally, status);
  if (status?.outcome && status.outcome !== outcomeOfStop(stop.stopReason, stop.error)) {
    return {
      stopReason: 'outcome_mismatch',
      error: `outcome_mismatch: the host reported ${status.outcome}, the stream ${stop.stopReason}`,
    };
  }
  return stop;
}

function streamStop(tally: SdkTally, status: HostStatus | undefined): { stopReason: string; error?: string } {
  if (status?.state === 'failed' || tally.hostError) {
    return { stopReason: 'host_error', error: `host_error: ${status?.error ?? tally.hostError ?? 'the host process failed'}` };
  }
  if (status?.stopReason === 'max_duration' || tally.maxDuration) return { stopReason: 'max_duration' };
  const subtype = tally.result?.subtype;
  if (!subtype) return { stopReason: 'no_result', error: 'the run ended without a result message' };
  if (FAILED_SUBTYPES.has(subtype)) {
    const detail = tally.result?.errors.join('; ');
    return { stopReason: subtype, error: detail ? `${subtype}: ${detail.slice(0, 1000)}` : subtype };
  }
  return { stopReason: subtype };
}

/**
 * The run's token totals. The result's modelUsage covers every model call,
 * subagents included, and is the only complete count: a streamed assistant
 * message carries its usage from the start of the response, before the
 * output is counted (on 2026-10-24 the summed messages showed 47 output
 * tokens against modelUsage's 806). The streamed calls still give the call
 * count and the per-call input sizes. Before a result arrives, as for a run
 * stopped part-way, the summed calls are all there is.
 */
export function runUsageOf(tally: SdkTally): RunUsage {
  const fromCalls = tally.calls.reduce(addCallUsage, emptyRunUsage());
  const models = Object.values(tally.result?.modelUsage ?? {}) as Record<string, unknown>[];
  if (models.length === 0) return fromCalls;
  const sum = (name: string): number => models.reduce((total, model) => total + count(model[name]), 0);
  const cacheRead = sum('cacheReadInputTokens');
  const cacheWrite = sum('cacheCreationInputTokens');
  const input = sum('inputTokens') + cacheRead + cacheWrite;
  const output = sum('outputTokens');
  return {
    ...fromCalls,
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    uncachedInputTokens: input - cacheRead,
  };
}
