/**
 * What a stage records about its agent's run: `build/usage.json` or
 * `review/usage.json`. Holds counts and identifiers only, never content.
 */
import type { CallUsage, RunUsage } from './usage.ts';
import type { SubagentRun, SubagentTotal } from './sdk-messages.ts';

/**
 * The Runtime version the `live` endpoint served, and its model and limits,
 * read when the run started (from the version's environment,
 * packages/agent-runtime/src/config.ts).
 */
export interface VersionInfo {
  runtimeName?: string;
  runtimeVersion?: string;
  modelId?: string;
  exploreModelId?: string;
  /** The version's own limits; the invoker passes none at invoke time. */
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxDurationSeconds?: number;
}

/** A runtime version's model and limits, from its environment variables. */
export function runtimeInfoOf(environment: Record<string, string> | undefined): VersionInfo {
  const env = environment ?? {};
  const number = (name: string): number | undefined => {
    const value = Number(env[name]);
    return env[name] !== undefined && Number.isFinite(value) ? value : undefined;
  };
  const info: VersionInfo = {};
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

export interface UsageRecord extends VersionInfo {
  /** How the run ended (the SDK's result subtype, or the host's own stop), or `interrupted` when the task was stopped first. */
  stopReason: string;
  toolCalls: number;
  durationSeconds: number;
  usage: RunUsage;
  /** One entry per model call, in order. */
  calls: CallUsage[];
  /** From the Agent SDK's result message. */
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
  /** Each subagent run in order and a total per agent type (see SubagentRun for where each figure comes from). Already inside the run's own totals. */
  subagents?: { runs: SubagentRun[]; totals: SubagentTotal[] };
}

export function usageRecord(params: {
  version: VersionInfo;
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
    ...params.version,
    stopReason: params.interrupted ? 'interrupted' : (params.stopReason ?? (params.error ? 'error' : 'unknown')),
    toolCalls: params.toolCalls,
    durationSeconds: Math.round((params.endedAt - params.startedAt) / 1000),
    usage: params.usage,
    calls: params.calls,
    ...(params.sdk ? { sdk: params.sdk } : {}),
    ...(params.error ? { error: params.error } : {}),
  };
}
