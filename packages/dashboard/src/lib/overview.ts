/**
 * The Overview (#58), built on the server from the ledger and thread rows:
 * the tiles, the stage graph's pucks, what needs attention, the agent
 * sessions running, the charts and the recently finished items. Everything a
 * model or a requester wrote is sanitised here, as in `summarise`.
 */
import { dayLabel, dayOf, lastDays } from './days.ts';
import { clip, fmtDur, fmtK, fmtTime, fmtUsd, shortId } from './format.ts';
import { actionsRunUrl } from './links.ts';
import type { LedgerRow, ThreadRow } from './records.ts';
import { oneLine, text } from './sanitise.ts';
import { graphStage, percentile, secondsBetween, stageDurations, stageKeyOf, stageLabel, STAGES, type GraphStage, type StageDuration } from './stages.ts';
import { currentStage, isStale, resultOf, RESULT_SINCE, type Pill } from './status.ts';
import { summarise, type WorkItemSummary } from './work-items.ts';

export interface TileModel {
  label: string;
  value: string;
  spark: number[];
  /** The line under the value: a coloured figure (`good` or not) and the baseline it is against. */
  delta?: { figure?: string; good?: boolean; text: string };
}

export type PuckKind = 'builder' | 'reviewer' | 'rework' | 'waiting';

export interface Puck {
  id: string;
  title: string;
  ref: string;
  stage: GraphStage;
  kind: PuckKind;
  /** The build round, when above 1. */
  round?: number;
  /** When the item was created: the puck shows how long it has been in flight. */
  since?: string;
  href: string;
}

export type NoticeTone = 'info' | 'ok' | 'warn' | 'crit';

export interface Notice {
  tone: NoticeTone;
  text: string;
  at: string;
  href?: string;
}

export interface SessionRow {
  id: string;
  ref: string;
  title: string;
  href: string;
  kind: 'agent' | 'test';
  role?: string;
  round?: number;
  /** When the run (or the Test stage) started, for a ticking elapsed time. */
  startedAt?: string;
  elapsedSeconds?: number;
  turns?: number;
  costUsd?: number;
  limits?: { maxTurns?: number; maxBudgetUsd?: number; maxDurationSeconds?: number };
  usage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number };
  lastEvent?: { type: string; at?: string };
  /** The run's live channel, for its last event. */
  channel?: string;
  testRun?: { id: string; url?: string };
}

export interface RecentRow {
  id: string;
  ref: string;
  title: string;
  status: Pill;
  durationSeconds?: number;
  costUsd?: number;
  href: string;
}

export interface Overview {
  generatedAt: string;
  tiles: TileModel[];
  stages: StageDuration[];
  pucks: Puck[];
  notices: Notice[];
  sessions: SessionRow[];
  throughput: { labels: string[]; prOpened: number[]; prUpdated: number[]; noPr: number[] };
  spend: { labels: string[]; values: number[] };
  recent: RecentRow[];
}

export interface OverviewInput {
  rows: LedgerRow[];
  threads: Map<string, ThreadRow>;
  now: number;
  /** CloudWatch alarms in `ALARM`, with when they entered it. */
  alarms?: { name: string; since?: string }[];
  /** The deploy workflow's runs on `main` (#59). */
  deploys?: DeployNotice[];
  resultSince?: string;
}

/** What Attention needs of a deploy run. */
export interface DeployNotice {
  sha: string;
  at: string;
  status: 'deployed' | 'skipped' | 'failed' | 'running' | 'cancelled';
  stacks?: string[];
  promoted?: { runtime: string; version: string }[];
}

/** A deploy in the last hour as an Attention notice: failed is critical, deployed and running are news, skipped is noise. */
export function deployNotice(d: DeployNotice): Notice | undefined {
  const sha = oneLine(d.sha).slice(0, 7);
  if (!/^[0-9a-f]{7}$/.test(sha) || !Number.isFinite(Date.parse(d.at))) return undefined;
  const stacks = d.stacks?.length ? ` ${d.stacks.map(oneLine).join(', ')}` : '';
  const promoted = d.promoted?.length ? `, promoted ${d.promoted.map((p) => `${oneLine(p.runtime).replace(/^factorial_/, '')} v${oneLine(p.version)}`).join(', ')}` : '';
  switch (d.status) {
    case 'failed':
      return { tone: 'crit', text: `Deploy of ${sha} failed`, at: d.at };
    case 'running':
      return { tone: 'info', text: `Deploy of ${sha} running`, at: d.at };
    case 'deployed':
      return { tone: 'ok', text: `Deployed ${sha}${stacks ? `:${stacks}` : ''}${promoted}`, at: d.at };
    default:
      return undefined;
  }
}

const HOUR = 3_600_000;
const FAILED = new Set(['failed', 'tests-failed', 'invalid-plan']);
const REWORK = /^github-(pull-request|workflow-run)/;

/** Where a row's run opens: its latest agent run, or the item while it has none. */
export function runHref(summary: WorkItemSummary): string {
  return summary.latestRun ? `/runs/${summary.id}/${summary.latestRun.stage}/${summary.latestRun.round}` : `/work-items/${summary.id}`;
}

/** A rough duration for a tile: `42s`, `38m`, `1h 05m`. */
export function roughDur(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return fmtDur(s);
}

const signed = (n: number, format: (v: number) => string) => (n > 0 ? `+${format(n)}` : n < 0 ? `−${format(-n)}` : '±0');
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

interface Facts {
  row: LedgerRow;
  summary: WorkItemSummary;
  result?: string;
  createdDay?: string;
  endedDay?: string;
  endedMs?: number;
}

function liveRunKey(row: LedgerRow): string | undefined {
  const live = row.live;
  if (!live || live.ended || !live.stage) return undefined;
  return stageKeyOf(live.stage, live.round ?? 1);
}

/** Per day: each run's cost and tokens, on the day it ended; a running run's live figures today, until its entry records them. */
function runsByDay(rows: LedgerRow[], today: string): { cost: Map<string, number>; tokens: Map<string, number>; input: Map<string, number>; cacheRead: Map<string, number> } {
  const cost = new Map<string, number>();
  const tokens = new Map<string, number>();
  const input = new Map<string, number>();
  const cacheRead = new Map<string, number>();
  const add = (map: Map<string, number>, day: string, value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) map.set(day, (map.get(day) ?? 0) + value);
  };
  for (const row of rows) {
    const recorded = new Set<string>();
    for (const [key, entry] of Object.entries(row.stages ?? {})) {
      const run = entry?.run;
      const at = entry?.endedAt ?? entry?.startedAt;
      if (!run || !at || !Number.isFinite(Date.parse(at))) continue;
      const day = dayOf(Date.parse(at));
      recorded.add(key);
      add(cost, day, run.costUsd);
      const usage = run.usage ?? {};
      add(tokens, day, (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
      add(input, day, usage.inputTokens);
      add(cacheRead, day, usage.cacheReadInputTokens);
    }
    const key = liveRunKey(row);
    if (key && !recorded.has(key) && row.live) {
      const usage = row.live.usage ?? {};
      add(cost, today, row.live.costUsd);
      add(tokens, today, (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
      add(input, today, usage.inputTokens);
      add(cacheRead, today, usage.cacheReadInputTokens);
    }
  }
  return { cost, tokens, input, cacheRead };
}

function tiles(facts: Facts[], rows: LedgerRow[], threads: Map<string, ThreadRow>, now: number): TileModel[] {
  const days = lastDays(now, 8);
  const today = days[7] as string;
  const yesterday = days[6] as string;
  const previousWeek = lastDays(now - 86_400_000, 7);
  const inFlight = facts.filter((f) => f.result === undefined);
  const repositories = new Set(inFlight.flatMap((f) => (f.summary.repository ? [`${f.summary.repository.owner}/${f.summary.repository.name}`.toLowerCase()] : [])));
  const flightOn = (day: string) => facts.filter((f) => f.createdDay !== undefined && f.createdDay <= day && (f.endedDay === undefined ? f.result === undefined : f.endedDay >= day)).length;

  const finishedOn = (day: string) => facts.filter((f) => f.endedDay === day).length;
  const finishedDiff = finishedOn(today) - finishedOn(yesterday);

  const opened = (day: string) => facts.filter((f) => f.endedDay === day && f.result === 'pr-opened');
  const openedToday = opened(today);
  const outcome = (f: Facts) => (f.row.threadKey ? threads.get(f.row.threadKey)?.outcome?.state : undefined);
  const merged = openedToday.filter((f) => outcome(f) === 'merged').length;
  const awaiting = openedToday.filter((f) => outcome(f) === undefined).length;

  const runs = runsByDay(rows, today);
  const spendToday = runs.cost.get(today) ?? 0;
  const weekMean = sum(previousWeek.map((d) => runs.cost.get(d) ?? 0)) / 7;
  const tokensToday = runs.tokens.get(today) ?? 0;
  const inputToday = runs.input.get(today) ?? 0;
  const hit = inputToday > 0 ? Math.round(((runs.cacheRead.get(today) ?? 0) / inputToday) * 100) : undefined;

  const toPr = (f: Facts) => {
    const start = f.row.workItem?.createdAt ?? f.row.createdAt;
    const end = f.summary.endedAt;
    return f.result === 'pr-opened' ? secondsBetween(start, end) : undefined;
  };
  const toPrOn = (list: string[]) => facts.filter((f) => f.endedDay !== undefined && list.includes(f.endedDay)).flatMap((f) => toPr(f) ?? []);
  const medianToday = percentile(toPrOn([today]), 50);
  const medianWeek = percentile(toPrOn(previousWeek), 50);
  const medianSpark = days.flatMap((d) => percentile(toPrOn([d]), 50) ?? []);

  return [
    { label: 'In flight', value: String(inFlight.length), spark: days.map(flightOn), delta: { text: `across ${plural(repositories.size, 'repository', 'repositories')}` } },
    { label: 'Finished today', value: String(finishedOn(today)), spark: days.map(finishedOn), delta: { figure: signed(finishedDiff, String), good: finishedDiff >= 0, text: 'vs yesterday' } },
    { label: 'Pull requests opened', value: String(openedToday.length), spark: days.map((d) => opened(d).length), delta: { text: `${merged} merged, ${awaiting} awaiting review` } },
    {
      label: 'Model spend today',
      value: fmtUsd(spendToday),
      spark: days.map((d) => runs.cost.get(d) ?? 0),
      delta: weekMean > 0 ? { figure: signed(Math.round(((spendToday - weekMean) / weekMean) * 100), (v) => `${v}%`), good: spendToday <= weekMean, text: 'vs 7-day mean' } : { text: 'no spend in the previous 7 days' },
    },
    { label: 'Tokens today', value: fmtK(tokensToday), spark: days.map((d) => runs.tokens.get(d) ?? 0), ...(hit !== undefined ? { delta: { text: `cache hit ${hit}%` } } : {}) },
    {
      label: 'Median issue to PR',
      value: medianToday !== undefined ? roughDur(medianToday) : '–',
      spark: medianSpark,
      delta:
        medianToday === undefined
          ? { text: 'no pull request opened today' }
          : medianWeek !== undefined
            ? { figure: signed(Math.round((medianToday - medianWeek) / 60), (v) => `${v}m`), good: medianToday <= medianWeek, text: 'vs last week' }
            : { text: 'none last week to compare' },
    },
  ];
}

function puckOf(f: Facts): Puck | undefined {
  if (f.result !== undefined) return undefined;
  const current = currentStage(f.row);
  const stage = graphStage(current?.stage) ?? (current ? undefined : 'Intake');
  if (!stage) return undefined;
  const kind: PuckKind = stage === 'Test' ? 'waiting' : REWORK.test(f.summary.source.type) ? 'rework' : stage === 'Review' ? 'reviewer' : 'builder';
  const round = stage === 'Build' && current?.round && current.round > 1 ? current.round : undefined;
  return {
    id: f.summary.id,
    title: f.summary.title,
    ref: f.summary.source.ref,
    stage,
    kind,
    ...(round ? { round } : {}),
    ...(f.summary.createdAt ? { since: f.summary.createdAt } : {}),
    href: runHref(f.summary),
  };
}

function notices(facts: Facts[], threads: Map<string, ThreadRow>, now: number, testP90: number | undefined, alarms: { name: string; since?: string }[], resultSince: string, deploys: DeployNotice[] = []): Notice[] {
  const out: Notice[] = [];
  const recent = (ms: number | undefined) => ms !== undefined && now - ms <= HOUR && ms <= now + 60_000;
  for (const f of facts) {
    const id = shortId(f.summary.id);
    if (f.result === 'refused' && recent(f.endedMs ?? Date.parse(f.row.createdAt ?? ''))) {
      const thread = f.row.threadKey ? threads.get(f.row.threadKey) : undefined;
      const holder = thread?.inFlight?.workItemId;
      const reason = oneLine(text(f.row.refusedReason));
      const code = f.row.status && f.row.status !== 'refused' ? ` (${oneLine(f.row.status)})` : '';
      const held = holder && holder !== f.summary.id ? `: thread ${oneLine(text(thread?.branch)) || 'unknown'} is held by ${shortId(holder)}` : '';
      out.push({ tone: 'info', text: clip(`Intake refused ${id}${code}${held}${reason ? `. ${reason}` : ''}`, 220), at: new Date(f.endedMs ?? Date.parse(f.row.createdAt ?? '')).toISOString(), href: `/work-items/${f.summary.id}` });
    }
    if (f.result !== undefined && FAILED.has(f.result) && recent(f.endedMs)) {
      const where = f.summary.stage ? ` in ${stageLabel(f.summary.stage)}` : '';
      out.push({ tone: 'crit', text: clip(`${id} ended ${f.result}${where}: ${f.summary.title}`, 220), at: new Date(f.endedMs as number).toISOString(), href: runHref(f.summary) });
    }
    if (isStale(f.row, now, resultSince) && f.row.live?.at) {
      const at = Date.parse(f.row.live.at);
      out.push({ tone: 'crit', text: `${id}'s run has not reported for ${fmtDur((now - at) / 1000)}: its invoker has stopped`, at: f.row.live.at, href: runHref(f.summary) });
    }
    if (f.result === undefined && testP90 !== undefined) {
      const test = f.row.stages?.Test;
      const started = test?.startedAt ? Date.parse(test.startedAt) : NaN;
      if (test && !test.endedAt && Number.isFinite(started) && (now - started) / 1000 > testP90) {
        out.push({ tone: 'warn', text: `Test stage waiting ${fmtDur((now - started) / 1000)} on GitHub Actions for ${id}, past its p90 of ${fmtDur(testP90)}`, at: new Date(started + testP90 * 1000).toISOString(), href: `/work-items/${f.summary.id}` });
      }
    }
  }
  for (const alarm of alarms) out.push({ tone: 'crit', text: `CloudWatch alarm ${oneLine(alarm.name)} is in ALARM`, at: alarm.since ?? new Date(now).toISOString() });
  for (const d of deploys) {
    const notice = recent(Date.parse(d.at)) ? deployNotice(d) : undefined;
    if (notice) out.push(notice);
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

function sessions(facts: Facts[]): SessionRow[] {
  const out: SessionRow[] = [];
  for (const f of facts) {
    if (f.result !== undefined) continue;
    const s = f.summary;
    const base = { id: s.id, ref: s.source.ref, title: s.title };
    if (s.waiting) {
      const test = f.row.stages?.Test;
      const run = s.repository ? actionsRunUrl(s.repository, f.row.testRunUrl) : undefined;
      out.push({ ...base, kind: 'test', href: `/work-items/${s.id}`, ...(test?.startedAt ? { startedAt: test.startedAt } : {}), ...(run ? { testRun: run } : {}) });
      continue;
    }
    const live = f.row.live;
    if (!live || live.ended || !live.stage || !/^[a-z]+$/.test(live.stage)) continue;
    const round = live.round ?? 1;
    const key = stageKeyOf(live.stage, round);
    const entry = key ? f.row.stages?.[key] : undefined;
    const at = live.at ? Date.parse(live.at) : NaN;
    const startedAt = entry?.startedAt ?? (Number.isFinite(at) && typeof live.elapsedSeconds === 'number' ? new Date(at - live.elapsedSeconds * 1000).toISOString() : undefined);
    const usage = live.usage ?? {};
    out.push({
      ...base,
      kind: 'agent',
      href: `/runs/${s.id}/${live.stage}/${round}`,
      role: oneLine(text(live.role)) || live.stage,
      round,
      ...(startedAt ? { startedAt } : {}),
      ...(typeof live.elapsedSeconds === 'number' ? { elapsedSeconds: live.elapsedSeconds } : {}),
      ...(typeof live.turns === 'number' ? { turns: live.turns } : {}),
      ...(typeof live.costUsd === 'number' ? { costUsd: live.costUsd } : {}),
      ...(live.limits ? { limits: live.limits } : {}),
      usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0, cacheReadInputTokens: usage.cacheReadInputTokens ?? 0 },
      ...(live.lastEvent?.type ? { lastEvent: { type: oneLine(live.lastEvent.type), ...(live.lastEvent.at ? { at: live.lastEvent.at } : {}) } } : {}),
      channel: `/factorial/runs/${s.id}/${live.stage}/${round}`,
    });
  }
  return out;
}

export function overview(input: OverviewInput): Overview {
  const { rows, threads, now } = input;
  const resultSince = input.resultSince ?? RESULT_SINCE;
  const facts: Facts[] = rows.map((row) => {
    const summary = summarise(row, row.threadKey ? threads.get(row.threadKey) : undefined, now, resultSince);
    const result = resultOf(row, resultSince);
    const created = Date.parse(row.createdAt ?? '');
    const ended = summary.endedAt ? Date.parse(summary.endedAt) : NaN;
    return {
      row,
      summary,
      ...(result !== undefined ? { result } : {}),
      ...(Number.isFinite(created) ? { createdDay: dayOf(created) } : {}),
      ...(Number.isFinite(ended) ? { endedDay: dayOf(ended), endedMs: ended } : {}),
    };
  });
  const durations = stageDurations(rows);
  const testP90 = durations.find((d) => d.stage === 'Test')?.p90;
  const days14 = lastDays(now, 14);
  const today = days14[13] as string;
  const runs = runsByDay(rows, today);
  const finished = (day: string, match: (r: string) => boolean) => facts.filter((f) => f.endedDay === day && f.result !== undefined && match(f.result)).length;
  const recent = facts
    .filter((f) => f.endedDay === today)
    .sort((a, b) => (b.endedMs ?? 0) - (a.endedMs ?? 0))
    .slice(0, 6)
    .map((f): RecentRow => {
      const duration = secondsBetween(f.row.createdAt, f.summary.endedAt);
      return {
        id: f.summary.id,
        ref: f.summary.source.ref,
        title: f.summary.title,
        status: f.summary.status,
        ...(duration !== undefined ? { durationSeconds: duration } : {}),
        ...(f.summary.costUsd !== undefined ? { costUsd: f.summary.costUsd } : {}),
        href: runHref(f.summary),
      };
    });
  const pucks = facts.flatMap((f) => puckOf(f) ?? []).sort((a, b) => (a.since ?? '').localeCompare(b.since ?? ''));
  return {
    generatedAt: new Date(now).toISOString(),
    tiles: tiles(facts, rows, threads, now),
    stages: durations,
    pucks,
    notices: notices(facts, threads, now, testP90, input.alarms ?? [], resultSince, input.deploys),
    sessions: sessions(facts),
    throughput: {
      labels: days14.map(dayLabel),
      prOpened: days14.map((d) => finished(d, (r) => r === 'pr-opened')),
      prUpdated: days14.map((d) => finished(d, (r) => r === 'pr-updated')),
      noPr: days14.map((d) => finished(d, (r) => r !== 'pr-opened' && r !== 'pr-updated')),
    },
    spend: { labels: days14.map(dayLabel), values: days14.map((d) => Math.round((runs.cost.get(d) ?? 0) * 100) / 100) },
    recent,
  };
}

/** A notice's time as the list shows it. */
export function noticeTime(at: string): string {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? fmtTime(new Date(ms)).slice(0, 5) : '';
}

export { STAGES };
