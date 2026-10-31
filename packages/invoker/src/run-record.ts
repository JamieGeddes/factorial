/**
 * What a stage records about its agent's run: `build/usage.json` or
 * `review/usage.json`. Holds counts and identifiers only, never content.
 */
import type { RunEntry } from '@factorial/progress';
import { RUN_CONTRACT_VARIABLE, type ModelRef, type ModelTotal, type RunOutcome } from '@factorial/run';

import type { LiveRecord } from './live-feed.ts';
import type { CallUsage, RunUsage } from './usage.ts';
import type { SubagentRun, SubagentTotal } from './run-events.ts';

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
  /** The reasoning effort the version fixes (`FACTORIAL_EFFORT`). */
  effort?: string;
  /** The version's own limits; the invoker passes none at invoke time. */
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxDurationSeconds?: number;
  /** The run contract the version's host speaks (contracts/run/v1/). */
  runContract?: number;
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
  if (env.FACTORIAL_EFFORT) info.effort = env.FACTORIAL_EFFORT;
  const maxTurns = number('FACTORIAL_MAX_TURNS');
  const maxBudgetUsd = number('FACTORIAL_MAX_BUDGET_USD');
  const maxDurationSeconds = number('FACTORIAL_MAX_DURATION_SECONDS');
  if (maxTurns !== undefined) info.maxTurns = maxTurns;
  if (maxBudgetUsd !== undefined) info.maxBudgetUsd = maxBudgetUsd;
  if (maxDurationSeconds !== undefined) info.maxDurationSeconds = maxDurationSeconds;
  const runContract = number(RUN_CONTRACT_VARIABLE);
  if (runContract !== undefined) info.runContract = runContract;
  return info;
}

export interface UsageRecord extends VersionInfo {
  /** How the run ended (run.ended's reason, or the invoker's own), or `interrupted` when the task was stopped first. */
  stopReason: string;
  toolCalls: number;
  durationSeconds: number;
  usage: RunUsage;
  /** One entry per model call, in order, each with its model and duration since #59. */
  calls: CallUsage[];
  /** Model calls the harness retried (`model.retry` events), since #59. */
  retries?: number;
  /** What the harness reported beyond the counts above. */
  harness?: HarnessRecord;
  /** The live feed (#194): events published and dropped, and the catch-up chunks stored. */
  live?: LiveRecord;
  error?: string;
}

/**
 * What the harness reports, from run.started and run.ended. costUsd is the
 * harness's estimate at list prices; models covers every model call,
 * subagents included, so it is the figure to compare with the summed calls.
 */
export interface HarnessRecord {
  name?: string;
  version?: string;
  /** The models the version names, by purpose. */
  configuredModels?: (ModelRef & { purpose: string })[];
  /** The harness's own code for the ending, e.g. an SDK result subtype. */
  detail?: string;
  turns?: number;
  costUsd?: number;
  models?: ModelTotal[];
  deniedToolCalls?: number;
  reconnects?: number;
  /** Events that did not meet the run contract; counted, never read. */
  invalidEvents?: number;
  /** Each subagent run in order and a total per agent type (see SubagentRun for where each figure comes from). Already inside the run's own totals. */
  subagents?: { runs: SubagentRun[]; totals: SubagentTotal[] };
}

/**
 * The harness's cost estimate as the invoker records it: rounded to 4 decimal
 * places (a hundredth of a cent), since the host sums per-call estimates as
 * floats and the figure is at list prices. Round only for recording; any sum
 * over rounds or items adds the rounded figures. undefined stays undefined.
 */
export function roundUsd(usd: number): number;
export function roundUsd(usd: number | undefined): number | undefined;
export function roundUsd(usd: number | undefined): number | undefined {
  return usd === undefined ? undefined : Math.round(usd * 10_000) / 10_000;
}

/** The harness record with every cost rounded for recording. */
function roundedHarness(harness: HarnessRecord): HarnessRecord {
  return {
    ...harness,
    ...(harness.costUsd !== undefined ? { costUsd: roundUsd(harness.costUsd) } : {}),
    ...(harness.models ? { models: harness.models.map((m) => (m.costUsd !== undefined ? { ...m, costUsd: roundUsd(m.costUsd) } : m)) } : {}),
  };
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
  retries?: number | undefined;
  harness?: HarnessRecord | undefined;
  live?: LiveRecord | undefined;
  error?: string | undefined;
}): UsageRecord {
  return {
    ...params.version,
    stopReason: params.interrupted ? 'interrupted' : (params.stopReason ?? (params.error ? 'error' : 'unknown')),
    toolCalls: params.toolCalls,
    durationSeconds: Math.round((params.endedAt - params.startedAt) / 1000),
    usage: params.usage,
    calls: params.calls,
    ...(params.retries !== undefined ? { retries: params.retries } : {}),
    ...(params.harness ? { harness: roundedHarness(params.harness) } : {}),
    ...(params.live ? { live: params.live } : {}),
    ...(params.error ? { error: params.error } : {}),
  };
}

/**
 * The run as its stage's entry in the progress record keeps it (#15): the
 * metadata usage.json holds, without the per-call list, the configured models
 * or anything the harness said.
 */
export function runEntryOf(params: {
  role: string;
  sessionId: string;
  version: VersionInfo;
  harness?: HarnessRecord | undefined;
  stopReason: string | undefined;
  outcome?: RunOutcome | undefined;
  toolCalls: number;
  durationSeconds: number;
  usage: RunUsage;
  /** The stored run record's ledger pointer; only its keys are kept. */
  record?: Record<string, unknown> | undefined;
}): RunEntry {
  const { version, harness, record } = params;
  return {
    role: params.role,
    ...(version.runtimeName ? { runtimeName: version.runtimeName } : {}),
    ...(version.runtimeVersion ? { runtimeVersion: version.runtimeVersion } : {}),
    ...(version.runContract !== undefined ? { runContract: version.runContract } : {}),
    ...(harness?.name ? { harness: { name: harness.name, ...(harness.version ? { version: harness.version } : {}) } } : {}),
    ...(version.modelId ? { modelId: version.modelId } : {}),
    ...(version.effort ? { effort: version.effort } : {}),
    sessionId: params.sessionId,
    toolCalls: params.toolCalls,
    ...(harness?.turns !== undefined ? { turns: harness.turns } : {}),
    durationSeconds: params.durationSeconds,
    ...(params.stopReason ? { stopReason: params.stopReason } : {}),
    ...(params.outcome ? { outcome: params.outcome } : {}),
    usage: { ...params.usage },
    ...(harness?.costUsd !== undefined ? { costUsd: roundUsd(harness.costUsd) } : {}),
    ...(typeof record?.transcriptKey === 'string' ? { transcriptKey: record.transcriptKey } : {}),
    ...(typeof record?.usageKey === 'string' ? { usageKey: record.usageKey } : {}),
  };
}
