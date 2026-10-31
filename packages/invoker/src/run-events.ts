/**
 * What the invoker reads from a run on a role's Runtime: the run events of
 * contracts/run/v1/, numbered by the host. Nothing here knows the harness or
 * the model's provider; the host's adapter (packages/agent-runtime) maps its
 * harness's messages to these events. The tally keeps tool calls, per-call
 * usage, subagent runs and how the run ended, as usage.json has recorded
 * them since the Harness, and what the harness reports beyond them: the
 * per-model totals, a cost estimate, turns and denied tool calls.
 */
import { RUN_CONTRACT, outcomeOfReason, validateRunEvent, type RunEnded, type RunEvent, type RunOutcome, type RunStarted, type RunStatus, type TokenUsage } from '@factorial/run';

import { redactSecrets } from '@factorial/artefacts';

import { roundUsd } from './run-record.ts';
import { addCallUsage, emptyRunUsage, type CallUsage, type RunUsage } from './usage.ts';

/**
 * One model call's usage in the shape usage.json has always had, with the
 * call's model and measured duration when the host reports them (#59), so
 * latency and tokens by model are read from usage.json alone.
 */
export function callUsageOf(usage: TokenUsage, call: { model?: { id?: string } | undefined; durationMs?: number | undefined } = {}): CallUsage {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
    cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
    ...(call.model?.id ? { model: call.model.id } : {}),
    ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
  };
}

/**
 * One finished subagent run. Duration and tool calls are the harness's
 * figures from subagent.ended. Its token figures are summed from the
 * subagent's own model.call events, matched by agentId: on #140 the SDK's
 * own total was the subagent's last call (25,735 tokens, its final context),
 * against 59,372 input tokens over its four calls. Input and cache tokens are
 * exact; when the harness reports calls before their output is finished,
 * output is a lower bound. The harness's figure is kept as
 * `finalContextTokens`.
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

/**
 * Text cut for a log line, redacted first. The logger redacts each whole line
 * too, but a cut that keeps the end can drop a credential's prefix and leave
 * its tail unrecognised; redacting before the cut cannot.
 */
const head = (text: string): string => redactSecrets(text).slice(0, 4000);
const tail = (text: string): string => redactSecrets(text).slice(-4000);

export interface LogLine {
  message: string;
  fields: Record<string, unknown>;
}

const MAX_LOGGED_PROBLEMS = 5;

export class RunTally {
  started: RunStarted | undefined;
  end: RunEnded | undefined;
  toolCalls = 0;
  calls: CallUsage[] = [];
  subagentRuns: SubagentRun[] = [];
  /** Events that did not meet the contract: logged and counted, never interpreted. */
  invalidEvents = 0;
  /** model.retry events: model calls the harness retried (#59). */
  retries = 0;
  /** Set when the first event shows the host speaks another contract. */
  contractMismatch: string | undefined;
  /** The sum of the hosts' per-call cost estimates, over the calls that carried one. */
  callCostUsd = 0;
  costedCalls = 0;
  /** The summed calls so far, for the `model call` lines. */
  private callTotal = emptyRunUsage();
  private events = 0;
  /** Each subagent's model calls so far, by agent id. */
  private readonly subagentCalls = new Map<string, RunUsage>();

  /** Takes one event and returns the log lines it is worth. */
  add(input: unknown): LogLine[] {
    this.events += 1;
    const result = validateRunEvent(input);
    if (this.events === 1) {
      if (!result.ok || result.value.type !== 'run.started') {
        const type = (input as { type?: unknown } | null)?.type;
        this.contractMismatch = `contract_mismatch: the host's first event was ${String(type ?? 'untyped')}, not a run.started for run contract ${RUN_CONTRACT}`;
        return [{ message: 'run contract mismatch', fields: { error: this.contractMismatch } }];
      }
    }
    if (!result.ok) {
      this.invalidEvents += 1;
      if (this.invalidEvents > MAX_LOGGED_PROBLEMS) return [];
      return [{ message: 'invalid run event', fields: { type: (input as { type?: unknown } | null)?.type, errors: result.errors.slice(0, 5) } }];
    }
    return this.take(result.value);
  }

  private take(event: RunEvent): LogLine[] {
    const agent = 'agentId' in event && event.agentId !== undefined ? 'subagent' : 'main';
    switch (event.type) {
      case 'run.started':
        this.started = event;
        return [{ message: 'run started', fields: { harness: event.harness, models: event.models } }];
      case 'model.call': {
        const call = callUsageOf(event.usage, event);
        this.calls.push(call);
        this.callTotal = addCallUsage(this.callTotal, call);
        if (event.agentId !== undefined) this.subagentCalls.set(event.agentId, addCallUsage(this.subagentCalls.get(event.agentId) ?? emptyRunUsage(), call));
        if (event.cost !== undefined) {
          this.callCostUsd += event.cost.usd;
          this.costedCalls += 1;
        }
        const { model: _model, durationMs, ...tokens } = call;
        return [
          {
            message: 'model call',
            fields: {
              agent,
              model: event.model?.id,
              usage: tokens,
              ...(durationMs !== undefined ? { durationMs } : {}),
              ...(event.cost !== undefined ? { costUsd: roundUsd(event.cost.usd) } : {}),
              total: this.callTotal,
              ...(this.costedCalls > 0 ? { totalCostUsd: roundUsd(this.callCostUsd) } : {}),
            },
          },
        ];
      }
      case 'tool.call': {
        this.toolCalls += 1;
        const input = JSON.stringify(event.input ?? {});
        return [{ message: 'tool use', fields: { tool: event.tool, agent, input: head(input), bytes: Buffer.byteLength(input) } }];
      }
      case 'tool.result':
        return [
          {
            message: 'tool result',
            fields: { callId: event.callId, agent, isError: event.isError ?? false, content: head(event.content), bytes: Buffer.byteLength(event.content) },
          },
        ];
      case 'text':
        return event.text.trim() ? [{ message: 'assistant text', fields: { agent, model: event.model?.id, text: tail(event.text) } }] : [];
      case 'reasoning':
        return event.text.trim() ? [{ message: 'reasoning', fields: { agent, model: event.model?.id, text: tail(event.text) } }] : [];
      case 'subagent.ended': {
        const usage = this.subagentCalls.get(event.agentId) ?? emptyRunUsage();
        this.subagentRuns.push({
          agentType: event.agentType,
          durationMs: event.durationMs ?? 0,
          toolUseCount: event.toolCalls ?? 0,
          modelCalls: usage.modelCalls,
          inputTokens: usage.inputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheWriteInputTokens: usage.cacheWriteInputTokens,
          outputTokensAtLeast: usage.outputTokens,
          finalContextTokens: event.finalContextTokens ?? 0,
        });
        return [];
      }
      case 'context.compacted':
        return [{ message: 'context compacted', fields: { agent, trigger: event.trigger, tokensBefore: event.tokensBefore, tokensAfter: event.tokensAfter } }];
      case 'model.retry':
        this.retries += 1;
        // The event names no model; the run's main model, from run.started,
        // lets the command centre count retries per inference profile (#59).
        return [{ message: 'model call retried', fields: { attempt: event.attempt, status: event.status, error: event.error, runModel: this.started?.models.find((m) => m.purpose === 'main')?.id } }];
      case 'run.ended':
        this.end = event;
        return [{ message: 'run ended', fields: { outcome: event.outcome, reason: event.reason, detail: event.detail, turns: event.turns, costUsd: roundUsd(event.cost?.usd) } }];
      default:
        return [];
    }
  }

  /** Whether the stream has ended: run.ended has arrived, or the host speaks another contract. */
  get ended(): boolean {
    return this.end !== undefined || this.contractMismatch !== undefined;
  }
}

export interface RunStop {
  outcome: RunOutcome;
  /** run.ended's reason, or the invoker's own: contract_mismatch, no_end, outcome_mismatch. */
  stopReason: string;
  error?: string;
}

/**
 * How the run ended, for the ledger and usage.json. The outcome decides:
 * complete, incomplete (a turn, budget or time limit: the rounds path) or
 * failed. The streamed events and the host's status come from the same
 * root-owned process, which the model cannot reach, but they are read
 * separately: when both are available and they disagree, or a known reason
 * contradicts its outcome, the run fails rather than trusting either.
 */
export function runtimeStop(tally: RunTally, status: RunStatus | undefined): RunStop {
  if (tally.contractMismatch) return { outcome: 'failed', stopReason: 'contract_mismatch', error: tally.contractMismatch };
  const end = tally.end ?? status?.ended;
  if (!end) {
    if (status?.state === 'failed') return { outcome: 'failed', stopReason: 'host_error', error: 'host_error: the host process failed' };
    return { outcome: 'failed', stopReason: 'no_end', error: 'the run ended without a run.ended event' };
  }
  const reported = status?.ended;
  if (reported && (reported.outcome !== end.outcome || reported.reason !== end.reason)) {
    return {
      outcome: 'failed',
      stopReason: 'outcome_mismatch',
      error: `outcome_mismatch: the host reported ${reported.outcome} (${reported.reason}), the stream ${end.outcome} (${end.reason})`,
    };
  }
  const implied = outcomeOfReason(end.reason);
  if (implied !== undefined && implied !== end.outcome) {
    return { outcome: 'failed', stopReason: 'outcome_mismatch', error: `outcome_mismatch: ${end.reason} is ${implied}, the host said ${end.outcome}` };
  }
  if (end.outcome !== 'failed') return { outcome: end.outcome, stopReason: end.reason };
  const detail = end.errors?.join('; ') ?? '';
  return { outcome: 'failed', stopReason: end.reason, error: detail ? `${end.reason}: ${detail.slice(0, 1000)}` : end.reason };
}

/**
 * The run's token totals. run.ended's per-model totals cover every model
 * call, subagents included, and are the complete count when present: a
 * harness may report a call before its output is counted (on 2026-10-24 the
 * SDK's summed calls showed 47 output tokens against its totals' 806). The
 * model.call events still give the call count and the per-call input sizes.
 * Before run.ended arrives, as for a run stopped part-way, the summed calls
 * are all there is.
 */
export function runUsageOf(tally: RunTally): RunUsage {
  const fromCalls = tally.calls.reduce(addCallUsage, emptyRunUsage());
  const models = tally.end?.models ?? [];
  if (models.length === 0) return fromCalls;
  const sum = (pick: (usage: TokenUsage) => number | undefined): number => models.reduce((total, model) => total + (pick(model.usage) ?? 0), 0);
  const input = sum((usage) => usage.inputTokens);
  const output = sum((usage) => usage.outputTokens);
  const cacheRead = sum((usage) => usage.cacheReadInputTokens);
  return {
    ...fromCalls,
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: sum((usage) => usage.cacheWriteInputTokens),
    uncachedInputTokens: input - cacheRead,
  };
}
