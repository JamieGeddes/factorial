import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Elapsed } from '../../../components/Elapsed.tsx';
import { MeterRow } from '../../../components/Meter.tsx';
import { Pill } from '../../../components/Pill.tsx';
import { Tag } from '../../../components/Tag.tsx';
import { fmtDur, fmtK, fmtUsd, shortId } from '../../../lib/format.ts';
import { branchUrl } from '../../../lib/links.ts';
import { text } from '../../../lib/sanitise.ts';
import { parseStageKey } from '../../../lib/stage-key.ts';
import { isWorkItemId } from '../../../server/artefacts.ts';
import { workItemDetail } from '../../../server/handlers.ts';
import { services } from '../../../server/services.ts';

export const dynamic = 'force-dynamic';

const seconds = (start?: string, end?: string): number | undefined => {
  const a = start ? Date.parse(start) : NaN;
  const b = end ? Date.parse(end) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / 1000 : undefined;
};

/** One work item: its row, thread and artefacts. Rows of the Work items view open here until #58's run view. */
export default async function WorkItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isWorkItemId(id)) notFound();
  const detail = await workItemDetail(services(), id);
  if (!detail) notFound();
  const { row, thread, summary, artefacts, links } = detail;
  const stages = Object.entries(row.stages ?? {}).sort(([, a], [, b]) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  const live = row.live;
  const branch = summary.repository && summary.branch ? branchUrl(summary.repository, summary.branch) : undefined;
  const prefix = `${id}/`;
  return (
    <section>
      <div className="run-head">
        <div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <h1>{`${summary.source.ref} · ${summary.title}`}</h1>
            <Pill pill={summary.status} />
          </div>
          <div className="ids">
            <Tag>{id}</Tag>
            <Tag>{`attempt ${summary.attempt}`}</Tag>
            {summary.branch ? <Tag>{summary.branch}</Tag> : null}
            {summary.repository ? <Tag>{`${summary.repository.owner}/${summary.repository.name}`}</Tag> : null}
            {links.execution ? (
              <a href={links.execution} target="_blank" rel="noreferrer noopener">
                Step Functions execution
              </a>
            ) : null}
            {links.artefacts ? (
              <a href={links.artefacts} target="_blank" rel="noreferrer noopener">
                {`Artefacts ${shortId(id)}/${summary.attempt}`}
              </a>
            ) : null}
            {branch ? (
              <a href={branch} target="_blank" rel="noreferrer noopener">
                Branch on GitHub
              </a>
            ) : null}
            {summary.pullRequest?.url ? (
              <a href={summary.pullRequest.url} target="_blank" rel="noreferrer noopener">{`PR #${summary.pullRequest.number}`}</a>
            ) : null}
          </div>
          {summary.status.note ? <p className="note">{summary.status.note}</p> : null}
        </div>
        <Link className="btn" href="/work-items">
          All work items
        </Link>
      </div>
      <div className="detail-grid">
        <div className="card span-7 flush">
          <div className="card-head" style={{ padding: '14px 16px 0' }}>
            <h2>Stages</h2>
            <span className="sub">From the progress record on the ledger row</span>
          </div>
          <table aria-label="Stages">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Started</th>
                <th className="right">Duration</th>
                <th>Outcome</th>
                <th className="right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {stages.length === 0 ? (
                <tr>
                  <td colSpan={5} className="empty">
                    No stages recorded: this item ran before the progress record (#15).
                  </td>
                </tr>
              ) : (
                stages.map(([key, entry]) => {
                  const { stage, round } = parseStageKey(key);
                  const d = seconds(entry.startedAt, entry.endedAt);
                  return (
                    <tr key={key}>
                      <td>
                        {stage}
                        {round ? <span className="sub">{`round ${round}`}</span> : null}
                      </td>
                      <td className="mono">{entry.startedAt?.replace('T', ' ').slice(0, 19) ?? ''}</td>
                      <td className="right num">{d !== undefined ? fmtDur(d) : entry.startedAt ? <Elapsed start={entry.startedAt} /> : ''}</td>
                      <td>
                        {entry.outcome ? <span className={`pill ${entry.outcome === 'succeeded' ? 'done' : 'failed'}`}>{entry.outcome}</span> : entry.startedAt ? <span className="pill running">running</span> : null}
                        {entry.error ? <span className="sub">{text(entry.error.name)}</span> : null}
                      </td>
                      <td className="right num">{typeof entry.run?.costUsd === 'number' ? fmtUsd(entry.run.costUsd) : ''}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="card span-5">
          <div className="card-head">
            <h2>Latest agent run</h2>
            <span className="sub">{live ? `${text(live.role)} · ${text(live.stage)}/${live.round ?? 1}${live.ended ? ' (ended)' : ''}` : 'none recorded'}</span>
          </div>
          {live ? (
            <div style={{ display: 'grid', gap: 10 }}>
              <MeterRow name="Turns" value={live.turns ?? live.modelCalls ?? 0} max={live.limits?.maxTurns} display={`${live.turns ?? live.modelCalls ?? 0} / ${live.limits?.maxTurns ?? '–'}`} />
              <MeterRow name="Budget" value={live.costUsd ?? 0} max={live.limits?.maxBudgetUsd} display={`${fmtUsd(live.costUsd ?? 0)} / ${live.limits?.maxBudgetUsd !== undefined ? fmtUsd(live.limits.maxBudgetUsd) : '–'}`} />
              <MeterRow name="Time" value={live.elapsedSeconds ?? 0} max={live.limits?.maxDurationSeconds} display={`${fmtDur(live.elapsedSeconds ?? 0)} / ${live.limits?.maxDurationSeconds !== undefined ? fmtDur(live.limits.maxDurationSeconds) : '–'}`} />
              <div className="kv">
                <div>
                  <span className="k">Input tokens</span>
                  <span className="v">{fmtK(live.usage?.inputTokens ?? 0)}</span>
                </div>
                <div>
                  <span className="k">Output tokens</span>
                  <span className="v">{fmtK(live.usage?.outputTokens ?? 0)}</span>
                </div>
                <div>
                  <span className="k">Tool calls</span>
                  <span className="v">{live.toolCalls ?? 0}</span>
                </div>
                <div>
                  <span className="k">Events</span>
                  <span className="v">{live.events ?? 0}</span>
                </div>
              </div>
              <p className="note" style={{ margin: 0 }}>
                The run and its transcript open in the Run &amp; transcript view once #58 adds it.
              </p>
            </div>
          ) : (
            <p className="note">This item has no live record (#194).</p>
          )}
        </div>
        <div className="card span-7">
          <div className="card-head">
            <h2>Request</h2>
            <span className="sub">{`${summary.source.label} · by ${summary.requester || 'unknown'}`}</span>
          </div>
          <pre className="detail-body">{text(row.workItem?.body) || '(no text)'}</pre>
        </div>
        <div className="card span-5">
          <div className="card-head">
            <h2>Thread</h2>
            <span className="sub">{row.threadKey ? 'factorial-threads' : 'none: before #163'}</span>
          </div>
          {thread ? (
            <div className="kv">
              <div>
                <span className="k">Branch</span>
                <span className="v mono">{text(thread.branch)}</span>
              </div>
              <div>
                <span className="k">Pull request</span>
                <span className="v">{thread.prNumber ? `#${thread.prNumber}` : 'none yet'}</span>
              </div>
              <div>
                <span className="k">Outcome</span>
                <span className="v">{thread.outcome ? `${thread.outcome.state} by ${text(thread.outcome.by)}` : 'open'}</span>
              </div>
              <div>
                <span className="k">Turn in flight</span>
                <span className="v mono">{thread.inFlight?.workItemId ? shortId(thread.inFlight.workItemId) : 'none'}</span>
              </div>
              <div>
                <span className="k">Automatic reworks</span>
                <span className="v">{thread.automaticReworks ?? 0}</span>
              </div>
            </div>
          ) : (
            <p className="note">No thread recorded.</p>
          )}
        </div>
        <div className="card span-12 flush">
          <div className="card-head" style={{ padding: '14px 16px 0' }}>
            <h2>Artefacts</h2>
            <span className="sub">{`Every attempt under ${prefix}`}</span>
          </div>
          <table aria-label="Artefacts">
            <thead>
              <tr>
                <th>Key</th>
                <th className="right">Size</th>
                <th>Last modified</th>
              </tr>
            </thead>
            <tbody>
              {artefacts.length === 0 ? (
                <tr>
                  <td colSpan={3} className="empty">
                    No artefacts under this item.
                  </td>
                </tr>
              ) : (
                artefacts.map((o) => {
                  const path = o.key.slice(prefix.length);
                  return (
                    <tr key={o.key}>
                      <td className="mono">
                        <a href={`/api/work-items/${id}/artefacts/${path.split('/').map(encodeURIComponent).join('/')}`} target="_blank" rel="noreferrer noopener">
                          {text(path)}
                        </a>
                      </td>
                      <td className="right num">{fmtK(o.size)}</td>
                      <td className="mono">{o.lastModified?.replace('T', ' ').slice(0, 19) ?? ''}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
