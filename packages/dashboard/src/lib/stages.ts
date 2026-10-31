/**
 * The state machine's stages as the Overview and the run view draw them, and
 * their durations over recent runs, from the ledger's `stages` entries (#15).
 */
import { parseStageKey } from './stage-key.ts';
import type { LedgerRow, StageEntry } from './records.ts';

/** The stage graph, in order. */
export const STAGES = ['Intake', 'Prepare', 'Build', 'Collect', 'Test', 'PrepareReview', 'Review', 'CollectReview', 'OpenPullRequest'] as const;
export type GraphStage = (typeof STAGES)[number];

const LABELS: Record<string, string> = { PrepareReview: 'Prepare review', CollectReview: 'Collect review', OpenPullRequest: 'Open PR' };

export function stageLabel(stage: string): string {
  return LABELS[stage] ?? stage;
}

/** States that are part of a graph stage: a build that saves its work or continues in a fresh session is still building. */
const ALIASES: Record<string, GraphStage> = { SaveWork: 'Build', ContinueBuild: 'Build' };

/** The graph stage a state machine state belongs to, or undefined for states the graph does not draw. */
export function graphStage(state: string | undefined): GraphStage | undefined {
  if (!state) return undefined;
  if ((STAGES as readonly string[]).includes(state)) return state as GraphStage;
  return ALIASES[state];
}

/** The run folder (`build`, `review`) of an agent stage, or undefined. */
export const RUN_FOLDERS: Record<string, string> = { Build: 'build', Review: 'review' };

/** The `stages` key of a run: `Build`, `Build#2`, `Review`. */
export function stageKeyOf(folder: string, round: number): string | undefined {
  const stage = Object.entries(RUN_FOLDERS).find(([, f]) => f === folder)?.[0];
  if (!stage) return undefined;
  return round > 1 ? `${stage}#${round}` : stage;
}

/** Seconds between two ISO times, or undefined. */
export function secondsBetween(start: string | undefined, end: string | undefined): number | undefined {
  const a = start ? Date.parse(start) : NaN;
  const b = end ? Date.parse(end) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / 1000 : undefined;
}

/** The `p`th percentile (0 to 100) of `values`, by linear interpolation; undefined when there are none. */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lo = sorted[low] as number;
  const hi = sorted[high] as number;
  return lo + (hi - lo) * (rank - low);
}

export interface StageDuration {
  stage: GraphStage;
  p50?: number;
  p90?: number;
  /** How many runs the figures come from, at most `window`. */
  runs: number;
}

/** Each graph stage's median and 90th percentile, in seconds, over its last `window` finished entries (every build round counts as one). */
export function stageDurations(rows: LedgerRow[], window = 30): StageDuration[] {
  const finished = new Map<GraphStage, { at: string; seconds: number }[]>();
  for (const row of rows) {
    for (const [key, entry] of Object.entries(row.stages ?? {})) {
      const stage = graphStage(parseStageKey(key).stage);
      const seconds = secondsBetween(entry?.startedAt, entry?.endedAt);
      if (!stage || seconds === undefined) continue;
      const list = finished.get(stage) ?? [];
      list.push({ at: entry.startedAt as string, seconds });
      finished.set(stage, list);
    }
  }
  return STAGES.map((stage) => {
    const recent = (finished.get(stage) ?? []).sort((a, b) => b.at.localeCompare(a.at)).slice(0, window).map((r) => r.seconds);
    const p50 = percentile(recent, 50);
    const p90 = percentile(recent, 90);
    return { stage, ...(p50 !== undefined ? { p50 } : {}), ...(p90 !== undefined ? { p90 } : {}), runs: recent.length };
  });
}

/** A row's stage entries in the order they started. */
export function orderedEntries(row: LedgerRow): [string, StageEntry][] {
  return Object.entries(row.stages ?? {})
    .filter(([, entry]) => typeof entry?.startedAt === 'string')
    .sort(([, a], [, b]) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
}
