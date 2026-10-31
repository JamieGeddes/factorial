/**
 * One function from the ledger to a status pill, used by every view (#57).
 *
 * A turn has ended once its row has a `result` (#165). Rows from before #165
 * never got one, so a row created before `RESULT_SINCE` has ended whatever it
 * holds, and its `status` stands in for the result.
 */
import { parseStageKey } from './stage-key.ts';
import type { LedgerRow, ThreadRow } from './records.ts';

/** When #165 (PR #224) reached `main`: every turn accepted since has a `result` once it ends. */
export const RESULT_SINCE = '2026-10-31T13:22:52Z';

/** A running item whose `live.at` is older than this has lost its invoker (`docs/finding-a-run.md` section 6). */
export const STALE_LIVE_MS = 60_000;

export type Tone = 'running' | 'waiting' | 'done' | 'failed' | 'refused';

export interface Pill {
  label: string;
  tone: Tone;
  /** A line under the pill: the saved work's branch, or a refusal's reason. */
  note?: string;
}

const AGENT_STAGES: Record<string, string> = { Build: 'building', Review: 'reviewing' };

/** The turn's result, or undefined while it is running. */
export function resultOf(row: LedgerRow, resultSince = RESULT_SINCE): string | undefined {
  if (typeof row.result === 'string') return row.result;
  if (row.createdAt !== undefined && row.createdAt < resultSince) {
    if (row.route === 'refuse') return 'refused';
    return row.status ?? 'failed';
  }
  if (row.createdAt === undefined) return row.status ?? 'failed';
  return undefined;
}

export interface CurrentStage {
  stage: string;
  round?: number;
  /** Whether the stage has started and not ended. */
  open: boolean;
}

/** The stage a row is in (the latest started without an end) or, once all have ended, the last one that ran. */
export function currentStage(row: LedgerRow): CurrentStage | undefined {
  const entries = Object.entries(row.stages ?? {}).filter(([, entry]) => typeof entry?.startedAt === 'string');
  if (entries.length === 0) return undefined;
  const open = entries.filter(([, entry]) => !entry.endedAt);
  const pool = open.length > 0 ? open : entries;
  const [key] = pool.reduce((latest, next) => ((next[1].startedAt ?? '') > (latest[1].startedAt ?? '') ? next : latest));
  const { stage, round } = parseStageKey(key);
  return { stage, ...(round !== undefined ? { round } : {}), open: open.length > 0 };
}

/** The highest build round a row records. */
export function buildRounds(row: LedgerRow): number {
  let rounds = typeof row.buildRounds === 'number' ? row.buildRounds : 0;
  for (const key of Object.keys(row.stages ?? {})) {
    const { stage, round } = parseStageKey(key);
    if (stage === 'Build') rounds = Math.max(rounds, round ?? 1);
  }
  return rounds;
}

function kebab(stage: string): string {
  return stage.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

export function statusPill(row: LedgerRow, thread?: ThreadRow, resultSince = RESULT_SINCE): Pill {
  const result = resultOf(row, resultSince);
  if (result === undefined) {
    const current = currentStage(row);
    const stage = current?.stage;
    if (stage === 'Test') return { label: 'testing', tone: 'waiting' };
    if (stage && AGENT_STAGES[stage]) {
      const round = current?.round;
      return { label: round && round > 1 ? `${AGENT_STAGES[stage]} r${round}` : AGENT_STAGES[stage] ?? stage, tone: 'running' };
    }
    return { label: stage ? kebab(stage) : (row.status ?? 'accepted'), tone: 'running' };
  }
  switch (result) {
    case 'pr-opened': {
      const state = thread?.outcome?.state;
      if (state === 'merged') return { label: 'merged', tone: 'done' };
      if (state === 'closed') return { label: 'closed', tone: 'refused' };
      return { label: 'pr-opened', tone: 'done' };
    }
    case 'pr-updated':
      return { label: 'pr-updated', tone: 'done' };
    case 'no-changes':
      return { label: 'no-changes', tone: 'refused' };
    case 'tests-failed':
    case 'invalid-plan':
      return { label: result, tone: 'failed' };
    case 'failed':
      return row.savedWork && row.branch ? { label: 'incomplete', tone: 'failed', note: `Saved to ${row.branch}` } : { label: 'failed', tone: 'failed' };
    case 'refused': {
      const code = row.status && row.status !== 'refused' ? `: ${row.status}` : '';
      return { label: `refused${code}`, tone: 'refused', ...(row.refusedReason ? { note: row.refusedReason } : {}) };
    }
    default:
      return { label: result, tone: 'failed' };
  }
}

/** Whether a running item's live progress has stopped: its invoker last wrote more than a minute ago. */
export function isStale(row: LedgerRow, now: number, resultSince = RESULT_SINCE): boolean {
  if (resultOf(row, resultSince) !== undefined) return false;
  const live = row.live;
  if (!live || live.ended || typeof live.at !== 'string') return false;
  const at = Date.parse(live.at);
  return Number.isFinite(at) && now - at > STALE_LIVE_MS;
}
