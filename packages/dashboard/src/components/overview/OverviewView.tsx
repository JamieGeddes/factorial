'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { useChannels } from '../../client/live.tsx';
import { useNow } from '../../client/now.tsx';
import { useRefreshed } from '../../client/refresh.tsx';
import { clip, fmtDur, fmtK, fmtUsd, shortId } from '../../lib/format.ts';
import { noticeTime, type Overview, type Puck, type SessionRow } from '../../lib/overview.ts';
import { emptyWatch, retryNotices, watchEvent, type RunWatch } from '../../lib/run-watch.ts';
import { graphStage, stageLabel, STAGES } from '../../lib/stages.ts';
import { fromEnvelope } from '../../lib/transcript.ts';
import { ColumnChart } from '../charts/ColumnChart.tsx';
import { HBarChart } from '../charts/HBarChart.tsx';
import { Meter } from '../Meter.tsx';
import { Pill, RolePill } from '../Pill.tsx';
import { Table, type Column } from '../Table.tsx';
import { Delta, Tile } from '../Tile.tsx';
import { StageGraph } from './StageGraph.tsx';

/** A tile delta as the mockup draws it: the coloured figure, then its baseline. */
function DeltaLine({ delta }: { delta: NonNullable<Overview['tiles'][number]['delta']> }) {
  return (
    <>
      {delta.figure ? (
        <>
          <Delta text={delta.figure} good={delta.good ?? true} />{' '}
        </>
      ) : null}
      {delta.text}
    </>
  );
}

/** Pucks with the progress that has arrived since the last read applied: a started stage moves its puck, an ended item removes it. */
function applyMoves(pucks: Puck[], moves: Map<string, { stage: Puck['stage']; round?: number } | null>): Puck[] {
  const out: Puck[] = [];
  for (const puck of pucks) {
    const move = moves.get(puck.id);
    if (move === null) continue;
    out.push(move ? { ...puck, stage: move.stage, kind: move.stage === 'Test' ? 'waiting' : puck.kind === 'waiting' ? 'builder' : puck.kind, ...(move.round && move.round > 1 ? { round: move.round } : {}) } : puck);
  }
  for (const [id, move] of moves) {
    if (move && !pucks.some((p) => p.id === id)) out.push({ id, title: 'new work item', ref: '', stage: move.stage, kind: move.stage === 'Test' ? 'waiting' : 'builder', href: `/work-items/${id}` });
  }
  return out;
}

function SessionMeter({ value, max, display, name }: { value: number; max: number | undefined; display: string; name: string }) {
  return (
    <>
      <div className="num">{display}</div>
      <div style={{ width: 80, marginTop: 4 }}>
        <Meter value={value} max={max} label={`${name}: ${display}`} />
      </div>
    </>
  );
}

function sessionColumns(now: number, watches: Record<string, RunWatch>): Column<SessionRow>[] {
  const elapsed = (row: SessionRow) => {
    const start = row.startedAt ? Date.parse(row.startedAt) : NaN;
    return Number.isFinite(start) && now ? (now - start) / 1000 : (row.elapsedSeconds ?? 0);
  };
  return [
    {
      key: 'item',
      header: 'Work item',
      render: (r) => (
        <>
          <span className="mono">{shortId(r.id)}</span>
          <span className="sub">{`${r.ref} · ${clip(r.title, 44)}`}</span>
        </>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (r) => (r.kind === 'test' ? <span className="pill waiting">Test</span> : <RolePill>{`${r.role ?? ''}${r.round && r.round > 1 ? ` r${r.round}` : ''}`}</RolePill>),
    },
    {
      key: 'elapsed',
      header: 'Elapsed',
      render: (r) => {
        const s = elapsed(r);
        if (r.kind === 'test') return <span className="num">{fmtDur(s)}</span>;
        const max = r.limits?.maxDurationSeconds;
        return <SessionMeter name="Elapsed" value={s} max={max} display={fmtDur(s)} />;
      },
    },
    {
      key: 'turns',
      header: 'Turns',
      render: (r) => {
        if (r.kind === 'test') return <span className="note" style={{ margin: 0 }}>No agent in session.</span>;
        const turns = r.turns ?? (r.channel ? watches[r.channel]?.turns : undefined) ?? 0;
        const max = r.limits?.maxTurns;
        return <SessionMeter name="Turns" value={turns} max={max} display={`${turns} / ${max ?? '–'}`} />;
      },
    },
    {
      key: 'budget',
      header: 'Budget',
      render: (r) => {
        if (r.kind === 'test')
          return (
            <span className="note" style={{ margin: 0 }}>
              {'Waiting on GitHub Actions'}
              {r.testRun ? (
                <>
                  {' run '}
                  {r.testRun.url ? (
                    <a href={r.testRun.url} target="_blank" rel="noreferrer noopener">
                      {r.testRun.id}
                    </a>
                  ) : (
                    r.testRun.id
                  )}
                </>
              ) : null}
              .
            </span>
          );
        const cost = r.costUsd ?? 0;
        const max = r.limits?.maxBudgetUsd;
        return <SessionMeter name="Budget" value={cost} max={max} display={`${fmtUsd(cost)} / ${max !== undefined ? fmtUsd(max) : '–'}`} />;
      },
    },
    {
      key: 'tokens',
      header: 'Tokens',
      render: (r) =>
        r.usage ? (
          <span className="num">
            {`${fmtK(r.usage.inputTokens)} in`}
            <span className="sub">{`${fmtK(r.usage.outputTokens)} out · ${r.usage.inputTokens ? Math.round((r.usage.cacheReadInputTokens / r.usage.inputTokens) * 100) : 0}% cached`}</span>
          </span>
        ) : null,
    },
    {
      key: 'last',
      header: 'Last event',
      render: (r) => {
        const watched = r.channel ? watches[r.channel]?.last?.text : undefined;
        return <span className="mono" style={{ color: 'var(--ink-2)' }}>{watched ?? r.lastEvent?.type ?? ''}</span>;
      },
    },
  ];
}

const RECENT: Column<Overview['recent'][number]>[] = [
  {
    key: 'item',
    header: 'Work item',
    render: (r) => (
      <>
        <span className="mono">{shortId(r.id)}</span>
        <span className="sub">{`${r.ref} · ${clip(r.title, 40)}`}</span>
      </>
    ),
  },
  { key: 'status', header: 'Result', render: (r) => <Pill pill={r.status} /> },
  { key: 'duration', header: 'Duration', align: 'right', render: (r) => (r.durationSeconds !== undefined ? fmtDur(r.durationSeconds) : '') },
  { key: 'cost', header: 'Cost', align: 'right', render: (r) => (r.costUsd !== undefined ? fmtUsd(r.costUsd) : '') },
];

const NOTES: Record<string, string> = { Test: 'Mostly GitHub Actions queue time', Build: 'Each round is a run; rounds add their own time' };

export function OverviewView({ initial }: { initial: Overview }) {
  const now = useNow();
  const [moves, setMoves] = useState(new Map<string, { stage: Puck['stage']; round?: number } | null>());
  const [watches, setWatches] = useState<Record<string, RunWatch>>({});
  const { data, error } = useRefreshed<Overview>('/api/overview', initial);

  // Read again: the moves are in the ledger now.
  const [seenAt, setSeenAt] = useState(data.generatedAt);
  if (seenAt !== data.generatedAt) {
    setSeenAt(data.generatedAt);
    setMoves(new Map());
  }

  useChannels(['/factorial/work-items'], (message) => {
    if (message.kind !== 'progress') return;
    const m = message.message;
    const id = typeof m.workItemId === 'string' ? m.workItemId : undefined;
    if (!id) return;
    if (m.stage === 'WorkItem' && m.transition === 'ended') {
      setMoves((prev) => new Map(prev).set(id, null));
      return;
    }
    const stage = graphStage(typeof m.stage === 'string' ? m.stage : undefined);
    if (stage && m.transition === 'started') setMoves((prev) => new Map(prev).set(id, { stage, ...(typeof m.round === 'number' ? { round: m.round } : {}) }));
  });

  const channels = data.sessions.flatMap((s) => (s.channel ? [s.channel] : [])).slice(0, 7);
  useChannels(channels, (message) => {
    if (message.kind !== 'event') return;
    const entry = fromEnvelope(message.envelope);
    if (!entry) return;
    setWatches((prev) => ({ ...prev, [message.channel]: watchEvent(prev[message.channel] ?? emptyWatch(), entry) }));
  });

  const pucks = useMemo(() => applyMoves(data.pucks, moves), [data.pucks, moves]);
  const notices = useMemo(() => [...data.notices, ...retryNotices(watches, now || Date.parse(data.generatedAt))].sort((a, b) => b.at.localeCompare(a.at)), [data.notices, watches, now, data.generatedAt]);
  const columns = useMemo(() => sessionColumns(now, watches), [now, watches]);

  return (
    <section>
      <div className="view-head">
        <h1>Overview</h1>
        <p>Everything in flight across the factory, refreshed from the live channel.</p>
      </div>
      {error ? <div className="error-note" role="alert">{`Could not read the ledger: ${error}`}</div> : null}
      <div className="tiles">
        {data.tiles.map((t) => (
          <Tile key={t.label} label={t.label} value={t.value} spark={t.spark} {...(t.delta ? { delta: <DeltaLine delta={t.delta} /> } : {})} />
        ))}
      </div>
      <div className="grid">
        <div className="card span-8 flush">
          <div className="stagemap">
            <div className="card-head" style={{ padding: '0 0 4px' }}>
              <h2>Stage graph</h2>
              <span className="sub">One work item per puck. Click a puck to open its run.</span>
            </div>
            <StageGraph stages={data.stages} pucks={pucks} />
            <div className="stagemap-key">
              <span>Builder session</span>
              <span className="k2">Reviewer session</span>
              <span className="k3">Rework turn</span>
              <span className="k4">Waiting on an external system</span>
              {pucks.length === 0 ? <span className="none">Nothing in flight.</span> : null}
            </div>
          </div>
        </div>
        <div className="card span-4">
          <div className="card-head">
            <h2>Attention</h2>
            <span className="sub">Alarms and admissions in the last hour</span>
          </div>
          {notices.length === 0 ? <p className="note">Nothing needs attention in the last hour.</p> : null}
          <div className="alerts" role="list" aria-label="Attention">
            {notices.map((n, i) => (
              <div key={`${n.at}-${i}`} className={`alert${n.tone === 'warn' ? '' : ` ${n.tone}`}`} role="listitem">
                <i />
                <div className="body">{n.href ? <Link href={n.href}>{n.text}</Link> : n.text}</div>
                <time className="when" dateTime={n.at}>
                  {noticeTime(n.at)}
                </time>
              </div>
            ))}
          </div>
        </div>
        <div className="card span-7 flush">
          <div className="card-head" style={{ padding: '14px 16px 0' }}>
            <h2>Agent sessions running</h2>
            <span className="sub">Burn against the Runtime version&apos;s limits</span>
          </div>
          <Table label="Agent sessions running" columns={columns} rows={data.sessions} rowKey={(r) => r.id} rowHref={(r) => r.href} empty="No agent session is running." />
        </div>
        <div className="card span-5">
          <div className="card-head">
            <h2>Throughput, 14 days</h2>
            <span className="sub">Work items finished per day by result</span>
          </div>
          <ColumnChart
            label="Work items finished per day by result, last 14 days"
            labels={data.throughput.labels}
            series={[
              { name: 'PR opened', color: 'var(--s1)', values: data.throughput.prOpened },
              { name: 'PR updated (rework)', color: 'var(--s3)', values: data.throughput.prUpdated },
              { name: 'No PR', color: 'var(--s2)', values: data.throughput.noPr },
            ]}
            fmt={(v) => String(Math.round(v))}
            height={160}
          />
        </div>
        <div className="card span-4">
          <div className="card-head">
            <h2>Stage duration</h2>
            <span className="sub">Median and 90th percentile, last 30 runs</span>
          </div>
          <HBarChart
            label="Median and 90th percentile duration per stage, last 30 runs"
            rows={STAGES.map((stage) => {
              const d = data.stages.find((s) => s.stage === stage);
              return { name: stageLabel(stage), v: d?.p50 ?? 0, ...(d?.p90 !== undefined ? { p90: d.p90 } : {}), ...(NOTES[stage] ? { note: NOTES[stage] } : {}) };
            })}
          />
        </div>
        <div className="card span-4">
          <div className="card-head">
            <h2>Model spend per day</h2>
            <span className="sub">Harness estimate at list price</span>
          </div>
          <ColumnChart label="Model spend per day, last 14 days" labels={data.spend.labels} series={[{ name: 'Spend', color: 'var(--s1)', values: data.spend.values }]} fmt={(v) => `$${Math.round(v)}`} height={160} />
        </div>
        <div className="card span-4 flush">
          <div className="card-head" style={{ padding: '14px 16px 0' }}>
            <h2>Recently finished</h2>
            <span className="sub">Today</span>
          </div>
          <Table label="Recently finished today" columns={RECENT} rows={data.recent} rowKey={(r) => r.id} rowHref={(r) => r.href} empty="Nothing has finished today." />
        </div>
      </div>
    </section>
  );
}
