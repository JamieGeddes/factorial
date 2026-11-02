'use client';

import { useEffect, useRef, useState } from 'react';

import { refine, turnTo, type Listing } from '../../lib/paging.ts';
import { filterRuns, runsEmptyMessage, runsSearch, type RunsQuery } from '../../lib/runs-list.ts';
import { FILTERS, FILTER_LABELS, isFilter, type WorkItemSummary } from '../../lib/work-items.ts';
import { FilterChips } from '../FilterChips.tsx';
import { RunsTable } from './RunsTable.tsx';

/**
 * Every item's latest agent run: the way into Run & transcript without a link.
 * Sorting, filtering and paging (50 a page) happen here, over the rows loaded.
 * The filter, search and page sit in the URL, so a link to a page opens on it.
 */
export function RunsView({ items, initialQuery = { filter: 'all', q: '' }, initialPage = 1 }: { items: WorkItemSummary[]; initialQuery?: RunsQuery; initialPage?: number }) {
  const [state, setState] = useState<Listing<RunsQuery>>({ query: initialQuery, page: initialPage });
  const { query, page } = state;
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const s = runsSearch(query, page);
    window.history.replaceState(null, '', s ? `?${s}` : window.location.pathname);
  }, [query, page]);

  return (
    <section>
      <div className="view-head">
        <h1>Run &amp; transcript</h1>
        <p>One agent run, live or finished. Choose one: newest created first, 50 to a page. Click a column to sort by it and again to reverse; search and status narrow the list.</p>
      </div>
      <div className="filters">
        <input
          className="search"
          type="search"
          placeholder="Search reference, title or id"
          aria-label="Search runs"
          value={query.q}
          onChange={(e) => setState((s) => refine(s, { q: e.target.value }))}
        />
        <FilterChips
          label="Filter by status"
          options={FILTERS.map((f) => ({ value: f, label: FILTER_LABELS[f] }))}
          value={query.filter}
          onChange={(filter) => setState((s) => refine(s, { filter: isFilter(filter) ? filter : 'all' }))}
        />
      </div>
      <div className="card flush">
        <RunsTable items={filterRuns(items, query)} empty={runsEmptyMessage(query)} paging={{ page, onPageChange: (p) => setState((s) => turnTo(s, p)) }} />
      </div>
    </section>
  );
}
