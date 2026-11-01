/**
 * The human scores on a ledger row (#227): `humanScores.<reviewer>`, one
 * entry per reviewer, written by the command centre's score route. Views
 * read only the entries for the row's current attempt, the attempt the
 * reviewer agent's `reviewVerdict` and `reviewScores` describe, and compute
 * the mean and count here, so the route never reads before it writes.
 */
import type { LedgerRow } from './records.ts';
import { oneLine, text } from './sanitise.ts';

export const SCORE_KEYS = ['correctness', 'completeness', 'tests', 'safety'] as const;
export type ScoreKey = (typeof SCORE_KEYS)[number];
export type Scores = Record<ScoreKey, number>;

export const VERDICTS = ['approve', 'request-changes', 'comment'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface HumanEntry {
  reviewer: string;
  attempt: number;
  verdict: Verdict;
  scores: Scores;
  at: string;
}

const isScore = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5;

/** The four scores, or undefined unless every one is an integer from 1 to 5. */
export function scoresOf(value: unknown): Scores | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  return SCORE_KEYS.every((k) => isScore(v[k])) ? (Object.fromEntries(SCORE_KEYS.map((k) => [k, v[k]])) as Scores) : undefined;
}

/** A verdict's pill, as the Work items view has always drawn the agent's: approve done, anything else waiting. */
export const verdictTone = (verdict: string): string => (verdict === 'approve' ? 'done' : 'waiting');

export const isVerdict = (v: unknown): v is Verdict => typeof v === 'string' && (VERDICTS as readonly string[]).includes(v);

/** The mean of whatever numeric scores a record holds. */
export function meanOf(scores: Record<string, unknown> | undefined): number | undefined {
  const values = Object.values(scores ?? {}).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
}

/** Well-formed entries for the row's current attempt, oldest first. */
export function humanEntries(row: LedgerRow): HumanEntry[] {
  const map = row.humanScores;
  if (typeof map !== 'object' || map === null) return [];
  const attempt = typeof row.attempt === 'number' ? row.attempt : 1;
  const entries: HumanEntry[] = [];
  for (const [reviewer, raw] of Object.entries(map as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    const scores = scoresOf(e.scores);
    if (e.attempt !== attempt || !isVerdict(e.verdict) || !scores || typeof e.at !== 'string') continue;
    entries.push({ reviewer: oneLine(text(reviewer)).slice(0, 64), attempt, verdict: e.verdict, scores, at: e.at });
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

/** What the Work items view shows: the latest verdict, and the mean of every reviewer's mean. */
export function humanSummary(row: LedgerRow): { verdict: Verdict; mean: number; count: number } | undefined {
  const entries = humanEntries(row);
  const latest = entries.at(-1);
  if (!latest) return undefined;
  const means = entries.map((e) => meanOf(e.scores) as number);
  return { verdict: latest.verdict, mean: means.reduce((a, b) => a + b, 0) / means.length, count: entries.length };
}
