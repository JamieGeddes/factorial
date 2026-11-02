'use client';

import { useMemo } from 'react';

import { useNow } from '../../client/now.tsx';
import { Elapsed } from '../Elapsed.tsx';
import { Pill } from '../Pill.tsx';
import { PullRequestLink, SourceLink } from '../SourceLink.tsx';
import { Table, type Column, type Paging } from '../Table.tsx';
import { clip, fmtUsd, shortId } from '../../lib/format.ts';
import { runHref } from '../../lib/overview.ts';
import type { WorkItemSummary } from '../../lib/work-items.ts';

/** Where a row leads: the item's latest agent run, or its detail while it has none. */
export function rowHref(item: WorkItemSummary): string {
  return runHref(item);
}

/**
 * Elapsed milliseconds from creation to the end, or to `now` while the item
 * runs (the creation time itself before the page clock has started, as
 * `Elapsed` shows). None for a refused turn, which shows no duration, and for
 * an item without a usable creation time.
 */
export function durationMs(item: WorkItemSummary, now: number): number | undefined {
  if (item.result === 'refused') return undefined;
  const from = item.createdAt ? Date.parse(item.createdAt) : NaN;
  if (!Number.isFinite(from)) return undefined;
  const to = item.endedAt ? Date.parse(item.endedAt) : now || from;
  return Number.isFinite(to) ? to - from : undefined;
}

/** The columns, each with what it sorts by; `now` is the page clock, for the Duration of a running item. */
export function workItemColumns(now: number): Column<WorkItemSummary>[] {
  return [
    {
      key: 'item',
      header: 'Work item',
      sortValue: (i) => i.source.ref || undefined,
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
      sortValue: (i) => (i.incomplete ? undefined : i.source.label || undefined),
      render: (i) =>
        i.incomplete ? (
          '–'
        ) : (
          <>
            {i.source.label}
            <span className="sub">
              <SourceLink source={i.source} />
              {i.requester ? ` · by ${i.requester}` : ''}
            </span>
          </>
        ),
    },
    {
      key: 'repository',
      header: 'Repository and thread',
      // A space, not a control character, between the two: the collator ignores those.
      sortValue: (i) => (i.repository ? `${i.repository.owner}/${i.repository.name} ${i.branch ?? ''}` : undefined),
      render: (i) => (
        <>
          {i.repository ? `${i.repository.owner}/${i.repository.name}` : ''}
          <span className="sub mono">
            {i.branch ?? ''}
            {i.pullRequest ? (
              <>
                {' → '}
                <PullRequestLink pullRequest={i.pullRequest} />
              </>
            ) : null}
          </span>
        </>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (i) => i.status.label,
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
      sortValue: (i) => (i.result === 'refused' ? 'Intake' : i.stage || undefined),
      render: (i) => (
        <>
          {i.result === 'refused' ? <span style={{ color: 'var(--ink-3)' }}>Intake</span> : (i.stage ?? '')}
          {i.rounds > 1 ? <span className="sub">{`${i.rounds} build rounds`}</span> : null}
        </>
      ),
    },
    { key: 'attempt', header: 'Attempt', sortValue: (i) => i.attempt, render: (i) => <span className="num">{i.attempt}</span> },
    {
      key: 'duration',
      header: 'Duration',
      align: 'right',
      sortValue: (i) => durationMs(i, now),
      render: (i) => (i.result === 'refused' ? '' : <Elapsed start={i.createdAt} end={i.endedAt} />),
    },
    { key: 'cost', header: 'Cost', align: 'right', sortValue: (i) => i.costUsd, render: (i) => (i.costUsd !== undefined ? fmtUsd(i.costUsd) : '') },
    {
      key: 'review',
      header: 'Review',
      sortValue: (i) => i.review?.mean,
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
}

export function WorkItemsTable({ items, empty, paging }: { items: WorkItemSummary[]; empty: string; paging?: Paging }) {
  const now = useNow();
  const columns = useMemo(() => workItemColumns(now), [now]);
  return <Table label="Work items" columns={columns} rows={items} rowKey={(i) => i.id} rowHref={rowHref} empty={empty} {...(paging ? { paging } : {})} />;
}
