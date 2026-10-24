/**
 * What the build stage records about the harness run: `build/usage.json`.
 * Holds counts and identifiers only, never content.
 */
import type { CallUsage, RunUsage } from './usage.ts';

/**
 * The version the `live` endpoint served, and its model and limits, read when
 * the run started: a harness's, or a runtime's (from the version's
 * environment, packages/agent-runtime/src/config.ts).
 */
export interface HarnessInfo {
  harnessName?: string;
  harnessVersion?: string;
  runtimeName?: string;
  runtimeVersion?: string;
  modelId?: string;
  exploreModelId?: string;
  /** The version's own limits; the invoker passes none at invoke time. */
  maxIterations?: number;
  timeoutSeconds?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxDurationSeconds?: number;
}

/** A runtime version's model and limits, from its environment variables. */
export function runtimeInfoOf(environment: Record<string, string> | undefined): HarnessInfo {
  const env = environment ?? {};
  const number = (name: string): number | undefined => {
    const value = Number(env[name]);
    return env[name] !== undefined && Number.isFinite(value) ? value : undefined;
  };
  const info: HarnessInfo = {};
  if (env.FACTORIAL_MODEL) info.modelId = env.FACTORIAL_MODEL;
  if (env.FACTORIAL_EXPLORE_MODEL) info.exploreModelId = env.FACTORIAL_EXPLORE_MODEL;
  const maxTurns = number('FACTORIAL_MAX_TURNS');
  const maxBudgetUsd = number('FACTORIAL_MAX_BUDGET_USD');
  const maxDurationSeconds = number('FACTORIAL_MAX_DURATION_SECONDS');
  if (maxTurns !== undefined) info.maxTurns = maxTurns;
  if (maxBudgetUsd !== undefined) info.maxBudgetUsd = maxBudgetUsd;
  if (maxDurationSeconds !== undefined) info.maxDurationSeconds = maxDurationSeconds;
  return info;
}

/** The model id from whichever provider block the harness configuration uses. */
export function modelIdOf(model: object | undefined): string | undefined {
  if (!model) return undefined;
  for (const config of Object.values(model)) {
    if (config && typeof config === 'object' && 'modelId' in config && typeof config.modelId === 'string') {
      return config.modelId;
    }
  }
  return undefined;
}

export interface UsageRecord extends HarnessInfo {
  /** The harness's own stop reason, or `interrupted` when the task was stopped first. */
  stopReason: string;
  toolCalls: number;
  durationSeconds: number;
  usage: RunUsage;
  /** One entry per model call, in order. */
  calls: CallUsage[];
  /** From the Agent SDK's result message, on a runtime only. */
  sdk?: SdkRecord;
  error?: string;
}

/**
 * What only the SDK reports. costUsd is the SDK's estimate at list prices;
 * modelUsage covers every model call, subagents included, so it is the
 * figure to compare with the summed calls.
 */
export interface SdkRecord {
  resultSubtype?: string;
  numTurns?: number;
  costUsd?: number;
  modelUsage?: Record<string, unknown>;
  permissionDenials?: number;
  reconnects?: number;
}

export function usageRecord(params: {
  harness: HarnessInfo;
  stopReason: string | undefined;
  interrupted: boolean;
  toolCalls: number;
  startedAt: number;
  endedAt: number;
  usage: RunUsage;
  calls: CallUsage[];
  sdk?: SdkRecord | undefined;
  error?: string | undefined;
}): UsageRecord {
  return {
    ...params.harness,
    stopReason: params.interrupted ? 'interrupted' : (params.stopReason ?? (params.error ? 'error' : 'unknown')),
    toolCalls: params.toolCalls,
    durationSeconds: Math.round((params.endedAt - params.startedAt) / 1000),
    usage: params.usage,
    calls: params.calls,
    ...(params.sdk ? { sdk: params.sdk } : {}),
    ...(params.error ? { error: params.error } : {}),
  };
}
