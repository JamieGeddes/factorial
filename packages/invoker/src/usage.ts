/**
 * Token accounting for one agent run. The stream carries one usage
 * record per model call, each covering only that call; the whole conversation
 * is resent on every call, so the run's consumption is the sum, not the last
 * record (which is roughly the final context size).
 */
export interface CallUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  cacheReadInputTokens?: number | undefined;
  cacheWriteInputTokens?: number | undefined;
}

export interface RunUsage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  /** Input tokens not served from the provider's cache. */
  uncachedInputTokens: number;
  /** Input tokens of the largest single call: the peak context size. */
  maxCallInputTokens: number;
  /** Input tokens of the last call: the context size at the end. */
  lastCallInputTokens: number;
}

export function emptyRunUsage(): RunUsage {
  return {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    uncachedInputTokens: 0,
    maxCallInputTokens: 0,
    lastCallInputTokens: 0,
  };
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

/** Add one round's total to another: the item's usage across build rounds. */
export function addRunUsage(a: RunUsage, b: RunUsage): RunUsage {
  return {
    modelCalls: a.modelCalls + b.modelCalls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    maxCallInputTokens: Math.max(a.maxCallInputTokens, b.maxCallInputTokens),
    lastCallInputTokens: b.lastCallInputTokens,
  };
}

/** Add one model call's usage record to the running total. */
export function addCallUsage(run: RunUsage, call: CallUsage | undefined): RunUsage {
  if (!call) return run;
  const input = count(call.inputTokens);
  const output = count(call.outputTokens);
  const cacheRead = count(call.cacheReadInputTokens);
  return {
    modelCalls: run.modelCalls + 1,
    inputTokens: run.inputTokens + input,
    outputTokens: run.outputTokens + output,
    totalTokens: run.totalTokens + (count(call.totalTokens) || input + output),
    cacheReadInputTokens: run.cacheReadInputTokens + cacheRead,
    cacheWriteInputTokens: run.cacheWriteInputTokens + count(call.cacheWriteInputTokens),
    uncachedInputTokens: run.uncachedInputTokens + Math.max(0, input - cacheRead),
    maxCallInputTokens: Math.max(run.maxCallInputTokens, input),
    lastCallInputTokens: input,
  };
}
