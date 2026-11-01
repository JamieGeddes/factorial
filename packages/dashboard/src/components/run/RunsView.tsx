'use client';

import { useState } from 'react';

import { filterRuns, runsEmptyMessage, type RunsQuery } from '../../lib/runs-list.ts';
import { FILTERS, FILTER_LABELS, isFilter, type WorkItemSummary } from '../../lib/work-items.ts';
import { FilterChips } from '../FilterChips.tsx';
import { RunsTable } from './RunsTable.tsx';

/** Every item's latest agent run: the way into Run & transcript without a link. Sorting and filtering happen here, over the rows loaded. */
export function RunsView({ items }: { items: WorkItemSummary[] }) {
  const [query, setQuery] = useState<RunsQuery>({ filter: 'all', q: '' });
  return (
    <section>
      <div className="view-head">
        <h1>Run &amp; transcript</h1>
        <p>One agent run, live or finished. Choose one: newest created first. Click a column to sort by it and again to reverse; search and status narrow the list.</p>
      </div>
      <div className="filters">
        <input
          className="search"
          type="search"
          placeholder="Search reference, title or id"
          aria-label="Search runs"
          value={query.q}
          onChange={(e) => setQuery({ ...query, q: e.target.value })}
        />
        <FilterChips
          label="Filter by status"
          options={FILTERS.map((f) => ({ value: f, label: FILTER_LABELS[f] }))}
          value={query.filter}
          onChange={(filter) => setQuery({ ...query, filter: isFilter(filter) ? filter : 'all' })}
        />
      </div>
      <div className="card flush">
        <RunsTable items={filterRuns(items, query)} empty={runsEmptyMessage(query)} />
      </div>
    </section>
  );
}
