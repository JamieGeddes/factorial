'use client';

import { Elapsed } from '../Elapsed.tsx';
import { Pill } from '../Pill.tsx';
import { Table, type Column } from '../Table.tsx';
import { clip, fmtUsd, shortId } from '../../lib/format.ts';
import type { WorkItemSummary } from '../../lib/work-items.ts';

/** Where a row leads: the item's latest run once #58 adds that view; until then, the item's detail. */
export function rowHref(item: WorkItemSummary): string {
  return `/work-items/${item.id}`;
}

const columns: Column<WorkItemSummary>[] = [
  {
    key: 'item',
    header: 'Work item',
    render: (i) => (
      <>
        <span className="mono">{shortId(i.id)}</span>
        <span className="sub">{clip(i.title, 60)}</span>
      </>
    ),
  },
  {
    key: 'source',
    header: 'Source',
    render: (i) => (
      <>
        {i.source.label}
        <span className="sub">
          {i.source.url ? (
            <a href={i.source.url} target="_blank" rel="noreferrer noopener">
              {i.source.ref}
            </a>
          ) : (
            i.source.ref
          )}
          {i.requester ? ` · by ${i.requester}` : ''}
        </span>
      </>
    ),
  },
  {
    key: 'repository',
    header: 'Repository and thread',
    render: (i) => (
      <>
        {i.repository ? `${i.repository.owner}/${i.repository.name}` : ''}
        <span className="sub mono">
          {i.branch ?? ''}
          {i.pullRequest ? (
            <>
              {' → '}
              {i.pullRequest.url ? (
                <a href={i.pullRequest.url} target="_blank" rel="noreferrer noopener">{`PR #${i.pullRequest.number}`}</a>
              ) : (
                `PR #${i.pullRequest.number}`
              )}
            </>
          ) : null}
        </span>
      </>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (i) => (
      <>
        <Pill pill={i.status} withNote />
        {i.stale ? <span className="sub">No live update for over a minute: the invoker has stopped</span> : null}
      </>
    ),
  },
  {
    key: 'stage',
    header: 'Stage',
    render: (i) => (
      <>
        {i.result === 'refused' ? <span style={{ color: 'var(--ink-3)' }}>Intake</span> : (i.stage ?? '')}
        {i.rounds > 1 ? <span className="sub">{`${i.rounds} build rounds`}</span> : null}
      </>
    ),
  },
  { key: 'attempt', header: 'Attempt', render: (i) => <span className="num">{i.attempt}</span> },
  { key: 'duration', header: 'Duration', align: 'right', render: (i) => (i.result === 'refused' ? '' : <Elapsed start={i.createdAt} end={i.endedAt} />) },
  { key: 'cost', header: 'Cost', align: 'right', render: (i) => (i.costUsd !== undefined ? fmtUsd(i.costUsd) : '') },
  {
    key: 'review',
    header: 'Review',
    render: (i) =>
      i.review ? (
        <>
          <span className={`pill ${i.review.verdict === 'approve' ? 'done' : 'waiting'}`}>{i.review.verdict}</span>{' '}
          {i.review.mean !== undefined ? (
            <span className="num" style={{ color: 'var(--ink-2)' }}>
              {i.review.mean.toFixed(2)}
            </span>
          ) : null}
        </>
      ) : (
        ''
      ),
  },
];

export function WorkItemsTable({ items, empty }: { items: WorkItemSummary[]; empty: string }) {
  return <Table label="Work items" columns={columns} rows={items} rowKey={(i) => i.id} rowHref={rowHref} empty={empty} />;
}
