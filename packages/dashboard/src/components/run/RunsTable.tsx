'use client';

import { clip, refAndTitle, shortId } from '../../lib/format.ts';
import { runHref } from '../../lib/overview.ts';
import type { WorkItemSummary } from '../../lib/work-items.ts';
import { Pill } from '../Pill.tsx';
import { Table, type Column } from '../Table.tsx';

export const RUN_COLUMNS: Column<WorkItemSummary>[] = [
  {
    key: 'item',
    header: 'Work item',
    sortValue: (i) => i.source.ref,
    render: (i) => (
      <>
        <span className="mono">{shortId(i.id)}</span>
        <span className="sub">{refAndTitle(i.source.ref, clip(i.title, 60))}</span>
      </>
    ),
  },
  { key: 'run', header: 'Latest run', sortValue: (i) => (i.latestRun ? `${i.latestRun.stage}/${i.latestRun.round}` : undefined), render: (i) => <span className="mono">{i.latestRun ? `${i.latestRun.stage}/${i.latestRun.round}` : ''}</span> },
  { key: 'status', header: 'Status', sortValue: (i) => i.status.label, render: (i) => <Pill pill={i.status} /> },
  { key: 'created', header: 'Created', sortValue: (i) => i.createdAt, render: (i) => <span className="mono">{i.createdAt?.replace('T', ' ').slice(0, 16) ?? ''}</span> },
];

/** Newest created first until a header is clicked; a running item keeps its status pill but no place of its own. */
export function RunsTable({ items, empty = 'No item has an agent run yet.' }: { items: WorkItemSummary[]; empty?: string }) {
  return <Table label="Agent runs" columns={RUN_COLUMNS} rows={items} rowKey={(i) => i.id} rowHref={runHref} empty={empty} defaultSort={{ key: 'created', dir: 'desc' }} />;
}
