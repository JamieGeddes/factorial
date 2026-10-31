/**
 * The Metrics and cost view (#59), built on the server from the ledger rows,
 * the threads and each run's `usage.json` facts, for one range (7, 30 or 90
 * days, ending today in local time) and optionally one repository. Every
 * chart's series comes back ready to draw.
 */
import { dayLabel, dayOf, lastDays } from './days.ts';
import { fmtDur, fmtUsd, shortId } from './format.ts';
import { roughDur, type TileModel } from './overview.ts';
import type { LedgerRow, RunEntry, ThreadRow } from './records.ts';
import { oneLine, text } from './sanitise.ts';
import { parseStageKey } from './stage-key.ts';
import { percentile, secondsBetween, STAGES } from './stages.ts';
import { buildRounds, resultOf, RESULT_SINCE } from './status.ts';
import { modelLabel, type UsageFacts } from './usage-facts.ts';
import { summarise, type WorkItemSummary } from './work-items.ts';

export const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];

export function isRange(value: unknown): value is Range {
  return RANGES.includes(Number(value) as Range);
}

export interface Chart {
  labels: string[];
  series: { name: string; values: number[] }[];
}

/** A line chart's series, with `null` where a label has no data. */
export interface LineData {
  labels: string[];
  series: { name: string; values: (number | null)[] }[];
}

export interface VersionRow {
  version: string;
  promoted?: { at: string; source: 'deploy' | 'created' };
  harness?: string;
  model?: string;
  runs: number;
  prRate?: number;
  medianSeconds?: number;
  roundsPerBuild?: number;
  costPerPr?: number;
  reviewScore?: number;
}

export interface Metrics {
  generatedAt: string;
  range: Range;
  repository: string;
  repositories: string[];
  /** `day` or `week`: what each column of the token chart covers. */
  bucket: 'day' | 'week';
  tiles: TileModel[];
  tokens: Chart;
  costByRole: Chart;
  outcomes: { name: string; v: number; tone: 'done' | 'update' | 'failed' | 'neutral' | 'refused' }[];
  scores: LineData;
  latency: LineData & { retries: (number | null)[] };
  /** Each role that ran in the range, in stage order (the builder first), and its versions. */
  versions: { roles: string[]; byRole: Record<string, VersionRow[]> };
  notes: string[];
}

export interface MetricsInput {
  rows: LedgerRow[];
  threads: Map<string, ThreadRow>;
  /** Each run's facts by its `usageKey`. */
  records: Map<string, UsageFacts>;
  now: number;
  range: Range;
  /** `owner/name`, or empty for every repository. */
  repository?: string;
  /** When each Runtime version was promoted: `<runtimeName> <version>` to an ISO time (the deploy runs' records). */
  promotions?: Map<string, string>;
  /** When each Runtime version was created, by role then version. */
  created?: Record<string, Record<string, string>>;
  resultSince?: string;
}

const PR_RESULTS = new Set(['pr-opened', 'pr-updated']);
const AUTOMATIC = /^github-workflow-run/;
const REQUESTED = /^github-pull-request/;
const SCORE_KEYS = ['correctness', 'completeness', 'tests', 'safety'];
const MAX_MODELS = 5;

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const mean = (values: number[]) => (values.length ? sum(values) / values.length : undefined);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function repositoryOf(row: LedgerRow): string | undefined {
  const repo = row.workItem?.repository;
  return typeof repo?.owner === 'string' && typeof repo.name === 'string' ? `${repo.owner}/${repo.name}` : undefined;
}

interface Item {
  row: LedgerRow;
  summary: WorkItemSummary;
  result?: string;
  endedMs?: number;
  endedDay?: string;
}

interface Run {
  item: Item;
  key: string;
  entry: RunEntry;
  role: string;
  /** The state that ran it: `Build`, `Review`. */
  stage: string;
  endedDay: string;
  facts?: UsageFacts;
}

/** The run entry's role, else its stage's name: no role is named here (a role is its manifest, in `@factorial/roles`). */
const roleOf = (stageKey: string, entry: RunEntry): string => (typeof entry.role === 'string' && /^[a-z]+$/.test(entry.role) ? entry.role : parseStageKey(stageKey).stage.toLowerCase());

/** Roles in the order their stages run, by the first stage each ran in. */
function rolesInOrder(runs: { role: string; stage: string }[]): string[] {
  const rank = (stage: string) => {
    const i = (STAGES as readonly string[]).indexOf(stage);
    return i < 0 ? STAGES.length : i;
  };
  const first = new Map<string, number>();
  for (const r of runs) first.set(r.role, Math.min(first.get(r.role) ?? Infinity, rank(r.stage)));
  return [...first].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([role]) => role);
}

const itemCost = (row: LedgerRow): number => sum(Object.values(row.stages ?? {}).map((e) => (typeof e?.run?.costUsd === 'number' ? e.run.costUsd : 0)));
/** Whether any of the item's runs recorded a cost: rows from before #15 hold none, and would read as free. */
const costed = (row: LedgerRow): boolean => Object.values(row.stages ?? {}).some((e) => typeof e?.run?.costUsd === 'number');

/** The range's days split into at most `n` contiguous groups, the last ending today. */
function groups(days: string[], n: number): string[][] {
  const size = Math.ceil(days.length / n);
  const out: string[][] = [];
  for (let end = days.length; end > 0; end -= size) out.unshift(days.slice(Math.max(0, end - size), end));
  return out;
}

/** ISO week number, for the review scores' weekly means. */
function isoWeek(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-w${String(week).padStart(2, '0')}`;
}

function uniqueLabels(labels: string[], ids: string[]): string[] {
  const seen = new Map<string, number>();
  for (const l of labels) seen.set(l, (seen.get(l) ?? 0) + 1);
  return labels.map((l, i) => ((seen.get(l) ?? 0) > 1 ? `${l} ${shortId(ids[i] ?? '')}` : l));
}

export function metrics(input: MetricsInput): Metrics {
  const { now, range } = input;
  const resultSince = input.resultSince ?? RESULT_SINCE;
  const repositories = [...new Set(input.rows.flatMap((r) => repositoryOf(r) ?? []))].sort((a, b) => a.localeCompare(b));
  const wanted = (input.repository ?? '').toLowerCase();
  const repository = repositories.find((r) => r.toLowerCase() === wanted) ?? '';
  const rows = repository ? input.rows.filter((r) => repositoryOf(r)?.toLowerCase() === wanted) : input.rows;

  const days = lastDays(now, range);
  const inRange = new Set(days);
  const bucket: Metrics['bucket'] = range === 90 ? 'week' : 'day';
  const columns = bucket === 'week' ? groups(days, Math.ceil(range / 7)) : days.map((d) => [d]);
  const columnOf = new Map<string, number>();
  columns.forEach((c, i) => c.forEach((d) => columnOf.set(d, i)));
  const columnLabels = columns.map((c) => dayLabel(c[0] as string));
  const sparks = groups(days, Math.min(8, range));

  const items: Item[] = rows.map((row) => {
    const summary = summarise(row, row.threadKey ? input.threads.get(row.threadKey) : undefined, now, resultSince);
    const result = resultOf(row, resultSince);
    const ended = summary.endedAt ? Date.parse(summary.endedAt) : NaN;
    return { row, summary, ...(result !== undefined ? { result } : {}), ...(Number.isFinite(ended) ? { endedMs: ended, endedDay: dayOf(ended) } : {}) };
  });
  const finished = items.filter((i) => i.result !== undefined && i.endedDay !== undefined && inRange.has(i.endedDay));
  const finishedOn = (group: string[]) => {
    const set = new Set(group);
    return finished.filter((i) => set.has(i.endedDay as string));
  };

  const runs: Run[] = [];
  for (const item of items) {
    for (const [key, stage] of Object.entries(item.row.stages ?? {})) {
      const entry = stage?.run;
      const at = stage?.endedAt;
      if (!entry || !at || !Number.isFinite(Date.parse(at))) continue;
      const endedDay = dayOf(Date.parse(at));
      if (!inRange.has(endedDay)) continue;
      const facts = typeof entry.usageKey === 'string' ? input.records.get(entry.usageKey) : undefined;
      runs.push({ item, key, entry, role: roleOf(key, entry), stage: parseStageKey(key).stage, endedDay, ...(facts ? { facts } : {}) });
    }
  }
  const runsOn = (group: string[]) => {
    const set = new Set(group);
    return runs.filter((r) => set.has(r.endedDay));
  };
  const notes: string[] = [];

  // ---- tiles ----
  const thread = (i: Item) => (i.row.threadKey ? input.threads.get(i.row.threadKey) : undefined);
  const prCosted = (list: Item[]) => list.filter((i) => i.result !== undefined && PR_RESULTS.has(i.result) && costed(i.row));
  const prCost = (list: Item[]) => percentile(prCosted(list).map((i) => itemCost(i.row)), 50);
  const toPr = (list: Item[]) => list.filter((i) => i.result === 'pr-opened').flatMap((i) => secondsBetween(i.row.workItem?.createdAt ?? i.row.createdAt, i.summary.endedAt) ?? []);
  const opened = (list: Item[]) => list.filter((i) => i.result === 'pr-opened');
  const merged = (list: Item[]) => opened(list).filter((i) => thread(i)?.outcome?.state === 'merged');
  /** Opened pull requests whose thread records how they ended (#204); one still open has none yet. */
  const decided = (list: Item[]) => opened(list).filter((i) => thread(i)?.outcome !== undefined);
  const rework = (list: Item[]) => ({
    automatic: list.filter((i) => AUTOMATIC.test(i.summary.source.type)).length,
    requested: list.filter((i) => REQUESTED.test(i.summary.source.type)).length,
  });
  const builds = (list: Item[]) => list.filter((i) => Object.keys(i.row.stages ?? {}).some((k) => parseStageKey(k).stage === 'Build'));
  const outOfTurns = (i: Item) => Object.entries(i.row.stages ?? {}).some(([k, e]) => parseStageKey(k).stage === 'Build' && e?.run?.stopReason === 'max_turns');

  const costMedian = prCost(finished);
  const prItems = prCosted(finished).length;
  const prTimes = toPr(finished);
  const p50 = percentile(prTimes, 50);
  const p90 = percentile(prTimes, 90);
  const openedN = opened(finished).length;
  const mergedN = merged(finished).length;
  const decidedN = decided(finished).length;
  const turns = rework(finished);
  const buildList = builds(finished);
  const needing = buildList.filter((i) => buildRounds(i.row) > 1).length;
  const ranOut = buildList.filter(outOfTurns).length;
  const recorded = runs.filter((r) => r.facts?.retries !== undefined);
  const retries = sum(recorded.map((r) => r.facts?.retries ?? 0));
  const retried = recorded.filter((r) => (r.facts?.retries ?? 0) > 0);
  const stillFailed = retried.filter((r) => r.entry.outcome === 'failed').length;
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : undefined);
  const spark = (f: (group: string[]) => number | undefined) => sparks.flatMap((g) => f(g) ?? []);
  const span = `${range} days`;

  const tiles: TileModel[] = [
    {
      label: 'Cost per pull request',
      value: costMedian !== undefined ? fmtUsd(costMedian) : '–',
      spark: spark((g) => prCost(finishedOn(g))),
      delta: { text: costMedian !== undefined ? `median of ${prItems}, ${span}` : `no pull request in ${span}` },
    },
    {
      label: 'Issue to PR, median',
      value: p50 !== undefined ? roughDur(p50) : '–',
      spark: spark((g) => percentile(toPr(finishedOn(g)), 50)),
      delta: { text: p90 !== undefined ? `p90 ${roughDur(p90)}` : `no pull request opened in ${span}` },
    },
    {
      label: 'PR merge rate',
      value: openedN && decidedN ? `${pct(mergedN, openedN)}%` : '–',
      spark: spark((g) => (decided(finishedOn(g)).length ? pct(merged(finishedOn(g)).length, opened(finishedOn(g)).length) : undefined)),
      delta: {
        text: !openedN ? `no pull request opened in ${span}` : decidedN ? `${mergedN} of ${openedN} opened` : `${openedN} opened, no outcome recorded`,
      },
    },
    {
      label: 'Rework turns per PR',
      value: openedN ? ((turns.automatic + turns.requested) / openedN).toFixed(1) : '–',
      spark: spark((g) => {
        const n = opened(finishedOn(g)).length;
        const t = rework(finishedOn(g));
        return n ? (t.automatic + t.requested) / n : undefined;
      }),
      delta: { text: openedN ? `automatic ${(turns.automatic / openedN).toFixed(1)}, requested ${(turns.requested / openedN).toFixed(1)}` : `${turns.automatic} automatic, ${turns.requested} requested` },
    },
    {
      label: 'Builds needing rounds',
      value: buildList.length ? `${pct(needing, buildList.length)}%` : '–',
      spark: spark((g) => {
        const b = builds(finishedOn(g));
        return pct(b.filter((i) => buildRounds(i.row) > 1).length, b.length);
      }),
      delta: { text: buildList.length ? `${needing} of ${buildList.length}, ${ranOut} ran out of turns` : `no build in ${span}` },
    },
    {
      label: 'Model call retries',
      value: recorded.length ? String(retries) : '–',
      spark: spark((g) => {
        const r = runsOn(g).filter((x) => x.facts?.retries !== undefined);
        return r.length ? sum(r.map((x) => x.facts?.retries ?? 0)) : undefined;
      }),
      delta: { text: recorded.length ? `${retried.length} runs retried, ${stillFailed} still failed` : 'recorded on runs since #59' },
    },
  ];

  // ---- tokens per model ----
  const totals = new Map<string, number[]>();
  for (const run of runs) {
    const column = columnOf.get(run.endedDay) as number;
    const models = run.facts?.models.length
      ? run.facts.models
      : [{ model: run.entry.modelId ?? 'unknown', tokens: (run.entry.usage?.inputTokens ?? 0) + (run.entry.usage?.outputTokens ?? 0) }];
    for (const m of models) {
      const values = totals.get(m.model) ?? columns.map(() => 0);
      values[column] = (values[column] ?? 0) + m.tokens;
      totals.set(m.model, values);
    }
  }
  const ranked = [...totals].sort((a, b) => sum(b[1]) - sum(a[1]));
  const kept = ranked.slice(0, MAX_MODELS);
  const other = ranked.slice(MAX_MODELS);
  const tokens: Chart = {
    labels: columnLabels,
    series: [
      ...kept.map(([model, values]) => ({ name: modelLabel(model), values })),
      ...(other.length ? [{ name: 'Other models', values: columns.map((_, i) => sum(other.map(([, v]) => v[i] ?? 0))) }] : []),
    ],
  };

  // ---- cost per item by role ----
  // Items that ran an agent: a refusal costs nothing and would only crowd the chart.
  const last20 = finished
    .filter((i) => Object.values(i.row.stages ?? {}).some((e) => e?.run))
    .sort((a, b) => (a.endedMs ?? 0) - (b.endedMs ?? 0))
    .slice(-20);
  const costRole = (i: Item, role: string) =>
    Math.round(sum(Object.entries(i.row.stages ?? {}).map(([k, e]) => (e?.run && roleOf(k, e.run) === role && typeof e.run.costUsd === 'number' ? e.run.costUsd : 0))) * 100) / 100;
  const lastRuns = last20.flatMap((i) => Object.entries(i.row.stages ?? {}).flatMap(([k, e]) => (e?.run ? [{ role: roleOf(k, e.run), stage: parseStageKey(k).stage }] : [])));
  const costByRole = {
    labels: uniqueLabels(
      last20.map((i) => i.summary.source.ref || shortId(i.summary.id)),
      last20.map((i) => i.summary.id),
    ),
    series: rolesInOrder(lastRuns).map((role) => ({ name: cap(role), values: last20.map((i) => costRole(i, role)) })),
  };

  // ---- outcomes ----
  const outcome = (i: Item): { name: string; tone: Metrics['outcomes'][number]['tone'] } => {
    switch (i.result) {
      case 'pr-opened':
        return { name: 'PR opened', tone: 'done' };
      case 'pr-updated':
        return { name: 'PR updated', tone: 'update' };
      case 'tests-failed':
        return { name: 'Tests failed', tone: 'failed' };
      case 'failed':
        return i.row.savedWork ? { name: 'Incomplete', tone: 'failed' } : { name: 'Failed', tone: 'failed' };
      case 'no-changes':
        return { name: 'No changes', tone: 'neutral' };
      case 'invalid-plan':
        return { name: 'Invalid plan', tone: 'failed' };
      case 'refused':
        return { name: 'Refused', tone: 'refused' };
      default:
        return { name: cap(oneLine(text(i.result)) || 'Unknown'), tone: 'failed' };
    }
  };
  const ORDER = ['PR opened', 'PR updated', 'Tests failed', 'Incomplete', 'Failed', 'No changes', 'Invalid plan', 'Refused'];
  const counts = new Map<string, { v: number; tone: Metrics['outcomes'][number]['tone'] }>();
  for (const i of finished) {
    const o = outcome(i);
    counts.set(o.name, { v: (counts.get(o.name)?.v ?? 0) + 1, tone: o.tone });
  }
  const outcomes = [...counts]
    .map(([name, c]) => ({ name, ...c }))
    .sort((a, b) => (ORDER.indexOf(a.name) + 1 || 99) - (ORDER.indexOf(b.name) + 1 || 99) || b.v - a.v);

  // ---- review scores, weekly ----
  const weeks = [...new Set(days.map(isoWeek))];
  const scored = finished.filter((i) => i.row.reviewScores && typeof i.row.reviewScores === 'object');
  const keys = [...SCORE_KEYS, ...[...new Set(scored.flatMap((i) => Object.keys(i.row.reviewScores ?? {})))].filter((k) => !SCORE_KEYS.includes(k) && /^[a-z]+$/.test(k)).sort()];
  const scores: LineData = {
    labels: weeks.map((w) => w.slice(5)),
    series: keys
      .map((k) => ({
        name: cap(k),
        values: weeks.map((w) => {
          const v = scored.filter((i) => isoWeek(i.endedDay as string) === w).flatMap((i) => (typeof i.row.reviewScores?.[k] === 'number' ? [i.row.reviewScores[k] as number] : []));
          const m = mean(v);
          return m !== undefined ? Math.round(m * 100) / 100 : null;
        }),
      }))
      .filter((s) => s.values.some((v) => v !== null)),
  };

  // ---- latency and retries ----
  const timedModels = new Map<string, number[][]>();
  let untimedRuns = 0;
  for (const run of runs) {
    if (!run.facts) continue;
    if (run.facts.timed.length === 0) untimedRuns += 1;
    const column = columnOf.get(run.endedDay) as number;
    for (const [model, ms] of run.facts.timed) {
      const perColumn = timedModels.get(model) ?? columns.map(() => [] as number[]);
      perColumn[column]?.push(ms / 1000);
      timedModels.set(model, perColumn);
    }
  }
  const retryColumns = columns.map((_, i) => {
    const r = runs.filter((x) => columnOf.get(x.endedDay) === i && x.facts?.retries !== undefined);
    return r.length ? sum(r.map((x) => x.facts?.retries ?? 0)) : null;
  });
  const latency = {
    labels: columnLabels,
    series: [...timedModels]
      .sort((a, b) => sum(b[1].map((c) => c.length)) - sum(a[1].map((c) => c.length)))
      .slice(0, MAX_MODELS)
      .map(([model, perColumn]) => ({ name: `${modelLabel(model)} p50 s`, values: perColumn.map((c) => (c.length ? Math.round((percentile(c, 50) as number) * 10) / 10 : null)) })),
    retries: retryColumns,
  };
  if (untimedRuns > 0) notes.push(`${untimedRuns} ${untimedRuns === 1 ? 'run' : 'runs'} in the range recorded no per-call model or latency (before #59) and ${untimedRuns === 1 ? 'is' : 'are'} left out of the latency chart.`);
  const missing = runs.filter((r) => !r.facts && typeof r.entry.usageKey === 'string').length;
  if (missing > 0) notes.push(`${missing} ${missing === 1 ? "run's" : "runs'"} usage.json could not be read; the ledger's figures stand in.`);

  // ---- Runtime versions ----
  const roles = rolesInOrder(runs);
  const versions = { roles, byRole: Object.fromEntries(roles.map((role) => [role, versionRows(runs, role, input)])) };

  return {
    generatedAt: new Date(now).toISOString(),
    range,
    repository,
    repositories,
    bucket,
    tiles,
    tokens,
    costByRole,
    outcomes,
    scores,
    latency,
    versions,
    notes,
  };
}

function versionRows(runs: Run[], role: string, input: MetricsInput): VersionRow[] {
  const byVersion = new Map<string, Run[]>();
  for (const run of runs) {
    if (run.role !== role) continue;
    const v = run.entry.runtimeVersion;
    if (typeof v !== 'string' || !/^\d{1,6}$/.test(v)) continue;
    byVersion.set(v, [...(byVersion.get(v) ?? []), run]);
  }
  const rows: VersionRow[] = [];
  for (const [version, list] of byVersion) {
    const first = list[list.length - 1]?.entry ?? {};
    const name = typeof first.runtimeName === 'string' ? first.runtimeName : `factorial_${role}`;
    const promotedAt = input.promotions?.get(`${name} ${version}`);
    const createdAt = input.created?.[role]?.[version];
    const items = [...new Map(list.map((r) => [r.item.row.workItemId, r.item])).values()];
    const done = items.filter((i) => i.result !== undefined);
    const prs = done.filter((i) => i.result !== undefined && PR_RESULTS.has(i.result)).length;
    const cost = sum(list.map((r) => (typeof r.entry.costUsd === 'number' ? r.entry.costUsd : 0)));
    const reviewScores = done.flatMap((i) => {
      const values = Object.values(i.row.reviewScores ?? {}).filter((v): v is number => typeof v === 'number');
      return values.length ? [sum(values) / values.length] : [];
    });
    const durations = list.flatMap((r) => (typeof r.entry.durationSeconds === 'number' ? [r.entry.durationSeconds] : []));
    const harness = first.harness?.name ? oneLine(text(`${first.harness.name}${first.harness.version ? ` ${first.harness.version}` : ''}`)) : undefined;
    const model = first.modelId ? `${modelLabel(first.modelId)}${first.effort ? `, effort ${oneLine(text(first.effort))}` : ''}` : undefined;
    const median = percentile(durations, 50);
    // Rounds belong to the Build stage: a role that runs there has them.
    const rounds = list.some((r) => r.stage === 'Build') ? mean(items.map((i) => Math.max(1, buildRounds(i.row)))) : undefined;
    const score = mean(reviewScores);
    rows.push({
      version,
      ...(promotedAt ? { promoted: { at: promotedAt, source: 'deploy' as const } } : createdAt ? { promoted: { at: createdAt, source: 'created' as const } } : {}),
      ...(harness ? { harness } : {}),
      ...(model ? { model } : {}),
      runs: list.length,
      ...(done.length ? { prRate: Math.round((prs / done.length) * 100) } : {}),
      ...(median !== undefined ? { medianSeconds: median } : {}),
      ...(rounds !== undefined ? { roundsPerBuild: Math.round(rounds * 10) / 10 } : {}),
      ...(prs ? { costPerPr: Math.round((cost / prs) * 100) / 100 } : {}),
      ...(score !== undefined ? { reviewScore: Math.round(score * 100) / 100 } : {}),
    });
  }
  return rows.sort((a, b) => Number(b.version) - Number(a.version));
}

/** A version row's duration as the table shows it. */
export function versionDuration(row: VersionRow): string {
  return row.medianSeconds !== undefined ? fmtDur(row.medianSeconds) : '–';
}
