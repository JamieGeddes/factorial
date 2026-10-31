'use client';

import { useMemo } from 'react';

import { useNow } from '../../client/now.tsx';
import { useRefreshed } from '../../client/refresh.tsx';
import { fmtWhen } from '../../lib/format.ts';
import type { DeployRow, Health } from '../../lib/health.ts';
import { ColumnChart } from '../charts/ColumnChart.tsx';
import { MeterRow } from '../Meter.tsx';
import { NotSetUp } from '../NotSetUp.tsx';
import { Table, type Column } from '../Table.tsx';

const STATUS_TEXT = { ok: 'ok', warn: 'warning', off: 'off' } as const;
const DEPLOY_PILL: Record<DeployRow['status'], string> = { deployed: 'done', skipped: 'refused', failed: 'failed', running: 'running', cancelled: 'refused' };

function deployColumns(now: number): Column<DeployRow>[] {
  return [
    {
      key: 'commit',
      header: 'Commit',
      render: (r) =>
        r.shaUrl ? (
          <a className="mono" href={r.shaUrl} target="_blank" rel="noreferrer noopener">
            {r.sha}
          </a>
        ) : (
          <span className="mono">{r.sha}</span>
        ),
    },
    {
      key: 'when',
      header: 'When',
      render: (r) => (
        <time dateTime={r.at} title={r.at}>
          {fmtWhen(r.at, now)}
        </time>
      ),
    },
    { key: 'title', header: 'Changed', render: (r) => r.title },
    { key: 'stacks', header: 'Stacks', render: (r) => r.stacks },
    { key: 'promoted', header: 'Promoted', render: (r) => r.promoted },
    {
      key: 'outcome',
      header: 'Outcome',
      render: (r) => (
        <a href={r.runUrl} target="_blank" rel="noreferrer noopener" aria-label={`Deploy run for ${r.sha}: ${r.status}`}>
          <span className={`pill ${DEPLOY_PILL[r.status]}`}>{r.attempt > 1 ? `${r.status}, attempt ${r.attempt}` : r.status}</span>
        </a>
      ),
    },
  ];
}

export function HealthView({ initial }: { initial: Health }) {
  const now = useNow();
  const { data, error } = useRefreshed<Health>('/api/health', initial, { everyMs: 60_000, wants: () => false });
  const columns = useMemo(() => deployColumns(now || Date.parse(data.generatedAt)), [now, data.generatedAt]);
  const w = data.webhooks;
  const alarms = data.alarms;

  return (
    <section>
      <div className="view-head">
        <h1>Health</h1>
        <p>Every component the pipeline depends on, with what it reported last.</p>
      </div>
      {error ? <div className="error-note" role="alert">{`Could not read health: ${error}`}</div> : null}
      <div className="grid">
        <div className="card span-5">
          <div className="card-head">
            <h2>Components</h2>
            <span className="sub">Checked every minute</span>
          </div>
          <ul className="components" aria-label="Components">
            {data.components.map((c) => (
              <li key={c.name} className="component">
                <span className={`dot${c.status === 'ok' ? '' : ` ${c.status}`}`} role="img" aria-label={STATUS_TEXT[c.status]} />
                <div>
                  {c.name}
                  <div className="d">{c.detail}</div>
                </div>
                <span className="r">{c.figure}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="card span-7">
          <div className="card-head">
            <h2>Alarms</h2>
            <span className="sub">CloudWatch alarms named factorial-*</span>
          </div>
          {alarms.error ? (
            <div className="error-note" role="alert">{`Could not read the alarms: ${alarms.error}`}</div>
          ) : alarms.list.length === 0 ? (
            <NotSetUp what="Alarms" issue={16}>
              No CloudWatch alarm named factorial-* exists in the account.
            </NotSetUp>
          ) : (
            <ul className="alerts" aria-label="Alarms">
              {alarms.list.map((a) => (
                <li key={a.name} className={`alert${a.state === 'ALARM' ? ' crit' : a.state === 'OK' ? ' ok' : ''}`}>
                  <i />
                  <div className="body">
                    <b>{a.name}</b>
                    {a.reason ? `: ${a.reason}` : ''}
                  </div>
                  <span className="when">{a.state}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="card-head" style={{ marginTop: 18 }}>
            <h2>Quotas</h2>
            <span className="sub">Peak use in the last hour against the account limit</span>
          </div>
          {data.quotas.error && data.quotas.meters.length === 0 ? <div className="error-note" role="alert">{`Could not read the quotas: ${data.quotas.error}`}</div> : null}
          <div style={{ display: 'grid', gap: 10 }}>
            {data.quotas.meters.map((q) => (
              <MeterRow key={q.name} name={q.name} value={q.used} max={q.limit} display={q.display} />
            ))}
          </div>
          {data.quotas.left.length ? <p className="note">{`Left out, with no usage metric to read: ${data.quotas.left.join('; ')}.`}</p> : null}
        </div>
        <div className="card span-7 flush">
          <div className="card-head" style={{ padding: '14px 16px 0' }}>
            <h2>Deploys and promotions</h2>
            <span className="sub">GitHub Actions on main</span>
          </div>
          {data.deploys.error ? (
            <div className="error-note" role="alert" style={{ margin: '0 16px 12px' }}>{`Could not read the deploy runs: ${data.deploys.error}`}</div>
          ) : null}
          <Table label="Deploys and promotions" columns={columns} rows={data.deploys.rows} rowKey={(r) => `${r.id}-${r.attempt}`} empty="No deploy run on main." />
          <p className="note" style={{ margin: '8px 16px 12px' }}>
            Stacks and promoted versions show for runs that record them (#59); earlier runs show –.
          </p>
        </div>
        <div className="card span-5">
          <div className="card-head">
            <h2>Webhook deliveries, 24 hours</h2>
            <span className="sub">GitHub App, per hour, from the adapter&apos;s log lines</span>
          </div>
          {w.error ? <div className="error-note" role="alert">{`Could not query the adapter's logs: ${w.error}`}</div> : null}
          {w.note ? <p className="note">{w.note}</p> : null}
          {w.totals.delivered === 0 ? (
            !w.note && !w.error ? <p className="note">No delivery logged in the last 24 hours.</p> : null
          ) : (
            <ColumnChart
              label="Webhook deliveries per hour, last 24 hours"
              labels={w.labels}
              series={[
                { name: 'Work items', color: 'var(--s1)', values: w.workItems },
                { name: 'Ignored', color: 'var(--hair-strong)', values: w.ignored },
                { name: 'Closed, rejected or failed', color: 'var(--s2)', values: w.other },
              ]}
              fmt={(v) => String(Math.round(v))}
              height={140}
            />
          )}
          <div className="kv" style={{ marginTop: 10 }}>
            <div>
              <span className="k">Delivered</span>
              <span className="v">{w.totals.delivered}</span>
            </div>
            <div>
              <span className="k">Became work items</span>
              <span className="v">{w.totals.workItems}</span>
            </div>
            <div>
              <span className="k">Ignored, with reason</span>
              <span className="v">{w.totals.ignored}</span>
            </div>
            <div>
              <span className="k">Pull requests closed</span>
              <span className="v">{w.totals.closed}</span>
            </div>
            <div>
              <span className="k">Rejected</span>
              <span className="v">{w.totals.rejected}</span>
            </div>
            <div>
              <span className="k">Failed</span>
              <span className="v">
                {w.totals.failed + w.totals.unhandled}
                {w.totals.unhandled ? <span className="note" style={{ margin: 0 }}>{` ${w.totals.unhandled} unhandled`}</span> : null}
              </span>
            </div>
          </div>
          {w.reasons.length ? (
            <>
              <h3 className="note" style={{ marginTop: 12 }}>
                Ignored, by reason
              </h3>
              <ul className="kv" style={{ gridTemplateColumns: '1fr auto', listStyle: 'none', padding: 0 }}>
                {w.reasons.map((r) => (
                  <li key={r.reason} style={{ display: 'contents' }}>
                    <span className="k">{r.reason}</span>
                    <span className="v">{r.n}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="note">GitHub&apos;s own delivery log needs the App&apos;s credentials, which the command centre never holds; redeliveries show as new deliveries.</p>
        </div>
      </div>
    </section>
  );
}
