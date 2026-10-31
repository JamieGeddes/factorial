'use client';

import { clip, shortId } from '../../lib/format.ts';
import { runHref } from '../../lib/overview.ts';
import type { WorkItemSummary } from '../../lib/work-items.ts';
import { Pill } from '../Pill.tsx';
import { Table, type Column } from '../Table.tsx';

const COLUMNS: Column<WorkItemSummary>[] = [
  {
    key: 'item',
    header: 'Work item',
    render: (i) => (
      <>
        <span className="mono">{shortId(i.id)}</span>
        <span className="sub">{`${i.source.ref} · ${clip(i.title, 60)}`}</span>
      </>
    ),
  },
  { key: 'run', header: 'Latest run', render: (i) => <span className="mono">{i.latestRun ? `${i.latestRun.stage}/${i.latestRun.round}` : ''}</span> },
  { key: 'status', header: 'Status', render: (i) => <Pill pill={i.status} /> },
  { key: 'created', header: 'Created', render: (i) => <span className="mono">{i.createdAt?.replace('T', ' ').slice(0, 16) ?? ''}</span> },
];

export function RunsTable({ items }: { items: WorkItemSummary[] }) {
  return <Table label="Agent runs" columns={COLUMNS} rows={items} rowKey={(i) => i.id} rowHref={runHref} empty="No item has an agent run yet." />;
}
