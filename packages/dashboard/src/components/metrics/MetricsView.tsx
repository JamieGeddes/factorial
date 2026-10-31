'use client';

import { useEffect, useMemo, useState } from 'react';

import { useNow } from '../../client/now.tsx';
import { useRefreshed } from '../../client/refresh.tsx';
import { fmtUsd, fmtWhen } from '../../lib/format.ts';
import { RANGES, versionDuration, type Metrics, type Range, type VersionRow } from '../../lib/metrics.ts';
import { ColumnChart } from '../charts/ColumnChart.tsx';
import { HBarChart } from '../charts/HBarChart.tsx';
import { LineChart } from '../charts/LineChart.tsx';
import { FilterChips } from '../FilterChips.tsx';
import { Table, type Column } from '../Table.tsx';
import { Tile } from '../Tile.tsx';

const PALETTE = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];
/** Roles in stage order: the first (the builder) blue, the next (the reviewer) violet, as the mockup draws them. */
const ROLE_COLOURS = ['var(--s1)', 'var(--s7)', 'var(--s3)', 'var(--s4)'];
const TONES: Record<Metrics['outcomes'][number]['tone'], string> = { done: 'var(--s1)', update: 'var(--s3)', failed: 'var(--s2)', neutral: 'var(--s4)', refused: 'var(--s8)' };

const dash = (v: number | undefined, f: (n: number) => string) => (v === undefined ? '–' : f(v));

function versionColumns(rows: VersionRow[], now: number): Column<VersionRow>[] {
  const builds = rows.some((r) => r.roundsPerBuild !== undefined);
  return [
    { key: 'version', header: 'Version', render: (r) => <span className="mono">{`v${r.version}`}</span> },
    { key: 'promoted', header: 'Promoted', render: (r) => (r.promoted ? <span title={r.promoted.source === 'created' ? 'When the version was created; no deploy run records its promotion' : 'From the deploy run that promoted it'}>{fmtWhen(r.promoted.at, now)}</span> : '–') },
    { key: 'harness', header: 'Harness', render: (r) => r.harness ?? '–' },
    { key: 'model', header: 'Model', render: (r) => r.model ?? '–' },
    { key: 'runs', header: 'Runs', align: 'right', render: (r) => <span className="num">{r.runs}</span> },
    { key: 'pr', header: 'PR rate', align: 'right', render: (r) => <span className="num">{dash(r.prRate, (v) => `${v}%`)}</span> },
    { key: 'duration', header: builds ? 'Median build' : 'Median run', align: 'right', render: (r) => <span className="num">{versionDuration(r)}</span> },
    ...(builds ? [{ key: 'rounds', header: 'Rounds per build', align: 'right' as const, render: (r: VersionRow) => <span className="num">{dash(r.roundsPerBuild, (v) => v.toFixed(1))}</span> }] : []),
    { key: 'cost', header: 'Cost per PR', align: 'right', render: (r) => <span className="num">{dash(r.costPerPr, fmtUsd)}</span> },
    { key: 'score', header: 'Review score', align: 'right', render: (r) => <span className="num">{dash(r.reviewScore, (v) => v.toFixed(2))}</span> },
  ];
}

const hasData = (series: { values: (number | null)[] }[]) => series.some((s) => s.values.some((v) => v !== null && v !== 0));

export function MetricsView({ initial }: { initial: Metrics }) {
  const now = useNow();
  const [range, setRange] = useState<Range>(initial.range);
  const [repository, setRepository] = useState(initial.repository);
  const [chosen, setRole] = useState<string | undefined>();
  const url = `/api/metrics?range=${range}${repository ? `&repository=${encodeURIComponent(repository)}` : ''}`;
  const { data, error } = useRefreshed<Metrics>(url, initial, { everyMs: 60_000, wants: (m) => m.stage === 'WorkItem' && m.transition === 'ended' });

  // The filters live in the address too, so a reload or a shared link keeps them.
  useEffect(() => {
    const next = `/metrics?range=${range}${repository ? `&repository=${encodeURIComponent(repository)}` : ''}`;
    if (`${window.location.pathname}${window.location.search}` !== next) window.history.replaceState(null, '', next);
  }, [range, repository]);

  const role = chosen && data.versions.roles.includes(chosen) ? chosen : (data.versions.roles[0] ?? '');
  const versionRowsShown = useMemo(() => data.versions.byRole[role] ?? [], [data.versions.byRole, role]);
  const columns = useMemo(() => versionColumns(versionRowsShown, now || Date.parse(data.generatedAt)), [versionRowsShown, now, data.generatedAt]);
  const per = data.bucket === 'week' ? 'week' : 'day';
  const stale = data.range !== range || data.repository !== repository;

  const latencySeries = [
    ...data.latency.series.map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length] as string })),
    ...(data.latency.retries.some((v) => v !== null) ? [{ name: 'Retries', color: 'var(--s7)', values: data.latency.retries }] : []),
  ];

  return (
    <section aria-busy={stale}>
      <div className="view-head">
        <h1>Metrics and cost</h1>
        <p>Per role, per model and per stage, from the progress record and the invoker&apos;s run records.</p>
      </div>
      <div className="filters">
        <FilterChips label="Range" options={RANGES.map((r) => ({ value: String(r), label: `${r} days` }))} value={String(range)} onChange={(v) => setRange(Number(v) as Range)} />
        <label className="note" style={{ marginLeft: 'auto' }}>
          {'Repository: '}
          <select className="search" value={repository} onChange={(e) => setRepository(e.target.value)}>
            <option value="">all</option>
            {data.repositories.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? <div className="error-note" role="alert">{`Could not read the metrics: ${error}`}</div> : null}
      <div className="tiles">
        {data.tiles.map((t) => (
          <Tile key={t.label} label={t.label} value={t.value} spark={t.spark} {...(t.delta ? { delta: t.delta.text } : {})} />
        ))}
      </div>
      <div className="grid">
        <div className="card span-6">
          <div className="card-head">
            <h2>{`Tokens per ${per} by model`}</h2>
            <span className="sub">Input and output, cache reads included</span>
          </div>
          {hasData(data.tokens.series) ? (
            <ColumnChart label={`Tokens per ${per} by model, last ${data.range} days`} labels={data.tokens.labels} series={data.tokens.series.map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length] as string }))} />
          ) : (
            <p className="note">No model calls in the range.</p>
          )}
        </div>
        <div className="card span-6">
          <div className="card-head">
            <h2>Cost per work item by role</h2>
            <span className="sub">Last 20 finished items that ran an agent</span>
          </div>
          {data.costByRole.labels.length ? (
            <ColumnChart
              label="Cost per work item by role, last 20 finished items"
              labels={data.costByRole.labels}
              series={data.costByRole.series.map((s, i) => ({ ...s, color: ROLE_COLOURS[i % ROLE_COLOURS.length] as string }))}
              fmt={(v) => `$${v.toFixed(1)}`}
            />
          ) : (
            <p className="note">No item finished in the range.</p>
          )}
        </div>
        <div className="card span-4">
          <div className="card-head">
            <h2>{`Outcomes, ${data.range} days`}</h2>
            <span className="sub">Where items ended</span>
          </div>
          {data.outcomes.length ? (
            <HBarChart label={`Where items ended, last ${data.range} days`} rows={data.outcomes.map((o) => ({ name: o.name, v: o.v, color: TONES[o.tone] }))} fmt={(v) => String(Math.round(v))} />
          ) : (
            <p className="note">No item finished in the range.</p>
          )}
        </div>
        <div className="card span-4">
          <div className="card-head">
            <h2>Review scores</h2>
            <span className="sub">Weekly mean, automated reviewer</span>
          </div>
          {data.scores.series.length ? (
            <LineChart label="Weekly mean review scores" labels={data.scores.labels} series={data.scores.series.map((s, i) => ({ ...s, color: PALETTE[i % PALETTE.length] as string }))} min={1} max={5} fmt={(v) => v.toFixed(1)} />
          ) : (
            <p className="note">No reviewed item finished in the range.</p>
          )}
        </div>
        <div className="card span-4">
          <div className="card-head">
            <h2>Model latency and retries</h2>
            <span className="sub">{`Model call p50 latency; retries per ${per}`}</span>
          </div>
          {hasData(latencySeries) ? (
            <LineChart label={`Model call p50 latency in seconds and retries per ${per}`} labels={data.latency.labels} series={latencySeries} fmt={(v) => v.toFixed(0)} />
          ) : (
            <p className="note">No timed model calls in the range: calls carry their duration from #59.</p>
          )}
        </div>
        <div className="card span-12 flush">
          <div className="card-head" style={{ padding: '14px 16px 0' }}>
            <h2>Runtime versions compared</h2>
            <span className="sub">{role ? `Each version that served runs in the range, ${role} role` : 'Each version that served runs in the range'}</span>
            {data.versions.roles.length > 1 ? (
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <FilterChips label="Role" options={data.versions.roles.map((r) => ({ value: r, label: r.charAt(0).toUpperCase() + r.slice(1) }))} value={role} onChange={setRole} />
              </span>
            ) : null}
          </div>
          <Table label={`Runtime versions compared${role ? `, ${role} role` : ''}`} columns={columns} rows={versionRowsShown} rowKey={(r) => r.version} empty="No agent run in the range." />
        </div>
      </div>
      {data.notes.map((n) => (
        <p key={n} className="note">
          {n}
        </p>
      ))}
    </section>
  );
}
