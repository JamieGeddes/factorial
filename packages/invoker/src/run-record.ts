/**
 * What the build stage records about the harness run: `build/usage.json`.
 * Holds counts and identifiers only, never content.
 */
import type { CallUsage, RunUsage } from './usage.ts';

/** The harness version the `live` endpoint served, and its model, read when the build started. */
export interface HarnessInfo {
  harnessName?: string;
  harnessVersion?: string;
  modelId?: string;
  /** The version's own limits; the invoker passes none at invoke time. */
  maxIterations?: number;
  timeoutSeconds?: number;
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
  error?: string;
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
  error?: string | undefined;
}): UsageRecord {
  return {
    ...params.harness,
    stopReason: params.interrupted ? 'interrupted' : (params.stopReason ?? (params.error ? 'error' : 'unknown')),
    toolCalls: params.toolCalls,
    durationSeconds: Math.round((params.endedAt - params.startedAt) / 1000),
    usage: params.usage,
    calls: params.calls,
    ...(params.error ? { error: params.error } : {}),
  };
}
