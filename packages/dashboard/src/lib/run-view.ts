/**
 * The Run & transcript view's header and side panels (#58), from the ledger
 * row: one agent run (`<stage>/<round>`, the run's channel and folder), the
 * item's stages as work and wait, the run's limits, record and session, and
 * the runs a reader can switch to.
 */
import { artefactsUrl, executionUrl } from './links.ts';
import type { LedgerRow, LiveProgress, RunEntry, ThreadRow } from './records.ts';
import { oneLine, text } from './sanitise.ts';
import { parseStageKey } from './stage-key.ts';
import { orderedEntries, RUN_FOLDERS, stageKeyOf, stageLabel, STAGES } from './stages.ts';
import { resultOf, RESULT_SINCE, type Pill } from './status.ts';
import type { PlanStep } from './transcript.ts';
import { summarise } from './work-items.ts';

export interface RunOption {
  href: string;
  label: string;
  group: 'item' | 'running';
  current: boolean;
}

export interface TimelineRow {
  key: string;
  name: string;
  startedAt?: string;
  endedAt?: string;
  /** Seconds since the previous stage ended: a Fargate start, a queue. */
  waitSeconds?: number;
  state: 'done' | 'failed' | 'live' | 'todo';
}

export interface Limits {
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxDurationSeconds?: number;
}

export interface RunRecord {
  runtimeName?: string;
  runtimeVersion?: string;
  harness?: { name: string; version?: string };
  modelId?: string;
  sessionId?: string;
  turns?: number;
  toolCalls?: number;
  durationSeconds?: number;
  costUsd?: number;
  outcome?: string;
  stopReason?: string;
  usage?: Record<string, number>;
}

export interface RunDetail {
  id: string;
  stage: string;
  round: number;
  role: string;
  channel: string;
  title: string;
  ref: string;
  status: Pill;
  attempt: number;
  branch?: string;
  repository?: string;
  sessionId?: string;
  links: { item: string; execution?: string; artefacts?: string; pullRequest?: { number: number; url?: string } };
  timeline: TimelineRow[];
  /** When this run's stage started, if it has. */
  startedAt?: string;
  /** This run has ended: its stage entry is closed, its live record says so, or the item has a result. */
  ended: boolean;
  /** The run's live record, when the ledger's `live` is this run's. */
  live?: LiveProgress;
  limits?: Limits;
  record?: RunRecord;
  /** The route serving the stored transcript, once the run has ended. */
  transcript?: string;
  plan?: { steps: PlanStep[]; source: string };
  options: RunOption[];
}

/** A run's folder under the attempt, as `runFolder` in `@factorial/live` (whose index a browser bundle cannot take). */
function runFolder(stage: string, round: number): string {
  return round > 1 ? `${stage}/round-${round}` : stage;
}

const ROLES: Record<string, string> = { build: 'builder', review: 'reviewer' };

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** The path, under the item, of a run's stored transcript. */
export function transcriptPath(row: LedgerRow, stage: string, round: number): string {
  const key = row.stages?.[stageKeyOf(stage, round) ?? '']?.run?.transcriptKey;
  if (typeof key === 'string' && key.startsWith(`${row.workItemId}/`) && key.endsWith('/transcript.jsonl')) return key.slice(row.workItemId.length + 1);
  const attempt = typeof row.attempt === 'number' ? row.attempt : 1;
  return `${attempt}/${runFolder(stage, round)}/transcript.jsonl`;
}

/** The artefact route for a path under the item. */
export function artefactRoute(id: string, path: string): string {
  return `/api/work-items/${id}/artefacts/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function runHrefOf(id: string, stage: string, round: number): string {
  return `/runs/${id}/${stage}/${round}`;
}

/** The item's runs, in the order they started, with the one asked for even before it starts. */
export function itemRuns(row: LedgerRow, current?: { stage: string; round: number }): { stage: string; round: number; startedAt?: string }[] {
  const runs: { stage: string; round: number; startedAt?: string }[] = [];
  for (const [key, entry] of orderedEntries(row)) {
    const { stage, round } = parseStageKey(key);
    const folder = RUN_FOLDERS[stage];
    if (folder) runs.push({ stage: folder, round: round ?? 1, ...(entry.startedAt ? { startedAt: entry.startedAt } : {}) });
  }
  const live = row.live;
  if (live?.stage && /^[a-z]+$/.test(live.stage) && !runs.some((r) => r.stage === live.stage && r.round === (live.round ?? 1))) runs.push({ stage: live.stage, round: live.round ?? 1 });
  if (current && !runs.some((r) => r.stage === current.stage && r.round === current.round)) runs.push(current);
  return runs;
}

function runLabel(id: string, stage: string, round: number, ended: boolean): string {
  return `${id.slice(0, 8)} · ${ROLES[stage] ?? stage} · ${stage}/${round} (${ended ? 'finished' : 'live'})`;
}

function liveIsThisRun(live: LiveProgress | undefined, stage: string, round: number): live is LiveProgress {
  return live?.stage === stage && (live.round ?? 1) === round;
}

export function runEnded(row: LedgerRow, stage: string, round: number, resultSince = RESULT_SINCE): boolean {
  if (resultOf(row, resultSince) !== undefined) return true;
  if (row.stages?.[stageKeyOf(stage, round) ?? '']?.endedAt) return true;
  return liveIsThisRun(row.live, stage, round) && row.live.ended === true;
}

/** The item's stages as work and wait, then the graph's stages it has not reached. */
export function timeline(row: LedgerRow): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let previousEnd: string | undefined;
  const seen = new Set<string>();
  for (const [key, entry] of orderedEntries(row)) {
    const { stage, round } = parseStageKey(key);
    seen.add(stage);
    const start = Date.parse(entry.startedAt ?? '');
    const prev = previousEnd ? Date.parse(previousEnd) : NaN;
    rows.push({
      key,
      name: `${stageLabel(stage)}${round && round > 1 ? ` r${round}` : ''}`,
      ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
      ...(entry.endedAt ? { endedAt: entry.endedAt } : {}),
      ...(Number.isFinite(start) && Number.isFinite(prev) && start > prev ? { waitSeconds: (start - prev) / 1000 } : {}),
      state: entry.endedAt ? (entry.outcome === 'failed' ? 'failed' : 'done') : 'live',
    });
    if (entry.endedAt) previousEnd = entry.endedAt;
  }
  for (const stage of STAGES) if (!seen.has(stage)) rows.push({ key: stage, name: stageLabel(stage), state: 'todo' });
  return rows;
}

function record(run: RunEntry | undefined): RunRecord | undefined {
  if (!run || typeof run !== 'object') return undefined;
  const t = (v: unknown) => oneLine(text(v));
  const harness = run.harness && typeof run.harness.name === 'string' ? { name: t(run.harness.name), ...(typeof run.harness.version === 'string' ? { version: t(run.harness.version) } : {}) } : undefined;
  return {
    ...(run.runtimeName ? { runtimeName: t(run.runtimeName) } : {}),
    ...(run.runtimeVersion ? { runtimeVersion: t(run.runtimeVersion) } : {}),
    ...(harness ? { harness } : {}),
    ...(run.modelId ? { modelId: t(run.modelId) } : {}),
    ...(run.sessionId ? { sessionId: t(run.sessionId) } : {}),
    ...(num(run.turns) !== undefined ? { turns: run.turns } : {}),
    ...(num(run.toolCalls) !== undefined ? { toolCalls: run.toolCalls } : {}),
    ...(num(run.durationSeconds) !== undefined ? { durationSeconds: run.durationSeconds } : {}),
    ...(num(run.costUsd) !== undefined ? { costUsd: run.costUsd } : {}),
    ...(run.outcome ? { outcome: t(run.outcome) } : {}),
    ...(run.stopReason ? { stopReason: t(run.stopReason) } : {}),
    ...(run.usage && typeof run.usage === 'object' ? { usage: Object.fromEntries(Object.entries(run.usage).filter(([, v]) => num(v) !== undefined)) } : {}),
  };
}

/** Limits from a record that names them: the live record's `limits`, or `usage.json`. */
export function limitsOf(value: unknown): Limits | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const limits: Limits = {
    ...(num(v.maxTurns) !== undefined ? { maxTurns: v.maxTurns as number } : {}),
    ...(num(v.maxBudgetUsd) !== undefined ? { maxBudgetUsd: v.maxBudgetUsd as number } : {}),
    ...(num(v.maxDurationSeconds) !== undefined ? { maxDurationSeconds: v.maxDurationSeconds as number } : {}),
  };
  return Object.keys(limits).length > 0 ? limits : undefined;
}

export interface RunDetailInput {
  row: LedgerRow;
  thread?: ThreadRow;
  stage: string;
  round: number;
  bucket?: string;
  /** Other items' rows that are running, for the session selector. */
  running?: LedgerRow[];
  /** The limits from the run's `usage.json`, once it has ended. */
  storedLimits?: Limits;
  plan?: { steps: PlanStep[]; source: string };
  now: number;
  resultSince?: string;
}

export function runDetail(input: RunDetailInput): RunDetail {
  const { row, stage, round, now } = input;
  const resultSince = input.resultSince ?? RESULT_SINCE;
  const id = row.workItemId;
  const summary = summarise(row, input.thread, now, resultSince);
  const entry = row.stages?.[stageKeyOf(stage, round) ?? ''];
  const live = liveIsThisRun(row.live, stage, round) ? row.live : undefined;
  const ended = runEnded(row, stage, round, resultSince);
  const execution = executionUrl(row.executionArn);
  const artefacts = artefactsUrl(input.bucket, row.artefactPrefix);
  const rec = record(entry?.run);
  const limits = (live ? limitsOf(live.limits) : undefined) ?? input.storedLimits;
  const options: RunOption[] = [
    ...itemRuns(row, { stage, round }).map((r) => ({
      href: runHrefOf(id, r.stage, r.round),
      label: runLabel(id, r.stage, r.round, runEnded(row, r.stage, r.round, resultSince)),
      group: 'item' as const,
      current: r.stage === stage && r.round === round,
    })),
    ...(input.running ?? [])
      .filter((other) => other.workItemId !== id && other.live && !other.live.ended && other.live.stage && /^[a-z]+$/.test(other.live.stage))
      .map((other) => {
        const s = other.live?.stage as string;
        const r = other.live?.round ?? 1;
        return { href: runHrefOf(other.workItemId, s, r), label: runLabel(other.workItemId, s, r, false), group: 'running' as const, current: false };
      }),
  ];
  return {
    id,
    stage,
    round,
    role: ROLES[stage] ?? stage,
    channel: `/factorial/runs/${id}/${stage}/${round}`,
    title: summary.title,
    ref: summary.source.ref,
    status: summary.status,
    attempt: summary.attempt,
    ...(summary.branch ? { branch: summary.branch } : {}),
    ...(summary.repository ? { repository: `${summary.repository.owner}/${summary.repository.name}` } : {}),
    ...(rec?.sessionId ? { sessionId: rec.sessionId } : {}),
    links: {
      item: `/work-items/${id}`,
      ...(execution ? { execution } : {}),
      ...(artefacts ? { artefacts } : {}),
      ...(summary.pullRequest ? { pullRequest: summary.pullRequest } : {}),
    },
    timeline: timeline(row),
    ...(entry?.startedAt ? { startedAt: entry.startedAt } : {}),
    ended,
    ...(live ? { live } : {}),
    ...(limits ? { limits } : {}),
    ...(rec ? { record: rec } : {}),
    ...(ended ? { transcript: artefactRoute(id, transcriptPath(row, stage, round)) } : {}),
    ...(input.plan ? { plan: input.plan } : {}),
    options,
  };
}
