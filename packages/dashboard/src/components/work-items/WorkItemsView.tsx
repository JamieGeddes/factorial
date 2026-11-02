'use client';

import { WORK_ITEMS_CHANNEL } from '@factorial/live/channels';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useChannels } from '../../client/live.tsx';
import { refine, turnTo, withPageParam, type Listing } from '../../lib/paging.ts';
import { readAll } from '../../lib/read-all.ts';
import { FilterChips } from '../FilterChips.tsx';
import { FILTERS, FILTER_LABELS, isFilter, type Filter, type WorkItemSummary } from '../../lib/work-items.ts';
import { WorkItemsTable } from './WorkItemsTable.tsx';

export interface WorkItemsData {
  items: WorkItemSummary[];
  total: number;
  sources: { type: string; label: string }[];
  counts: { running: number; waiting: number };
  nextCursor?: string;
}

export interface Query {
  filter: Filter;
  source: string;
  q: string;
}

/** The empty state names what to clear. */
export function emptyMessage(query: Query, sources: { type: string; label: string }[]): string {
  const active: string[] = [];
  if (query.filter !== 'all') active.push(`the ${FILTER_LABELS[query.filter]} filter`);
  if (query.source) active.push(`the source ${sources.find((s) => s.type === query.source)?.label ?? query.source}`);
  if (query.q.trim()) active.push(`the search “${query.q.trim()}”`);
  if (active.length === 0) return 'The ledger holds no work items yet.';
  const list = active.length === 1 ? active[0] : `${active.slice(0, -1).join(', ')} or ${active.at(-1)}`;
  return `No work items match. Clear ${list} to see more.`;
}

/** The API parameters for a query (no page: paging happens in the browser). */
export function search(query: Query): string {
  const params = new URLSearchParams();
  if (query.filter !== 'all') params.set('filter', query.filter);
  if (query.source) params.set('source', query.source);
  if (query.q.trim()) params.set('q', query.q.trim());
  return params.toString();
}

/** The page's own URL parameters: the query's, and the page beside them when it is not the first. */
export function pageSearch(query: Query, page: number): string {
  return withPageParam(new URLSearchParams(search(query)), page).toString();
}

/** Every item matching the query: the API is read a page of 500 at a time, following `nextCursor`. */
export function readAllWorkItems(query: Query, fetchJson: (url: string) => Promise<WorkItemsData>): Promise<Omit<WorkItemsData, 'nextCursor'>> {
  const base = search(query);
  return readAll((cursor) => fetchJson(`/api/work-items?${base ? `${base}&` : ''}limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
}

async function fetchJson(url: string): Promise<WorkItemsData> {
  const response = await fetch(url, { cache: 'no-store' });
  const body = (await response.json()) as WorkItemsData & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

export function WorkItemsView({ initial, initialQuery, initialPage = 1 }: { initial: Omit<WorkItemsData, 'nextCursor'>; initialQuery: Query; initialPage?: number }) {
  const [state, setState] = useState<Listing<Query>>({ query: initialQuery, page: initialPage });
  const { query, page } = state;
  const [data, setData] = useState<Omit<WorkItemsData, 'nextCursor'>>(initial);
  const [error, setError] = useState<string | undefined>();
  const latest = useRef(query);
  latest.current = query;
  const firstUrl = useRef(true);
  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    const q = latest.current;
    try {
      const body = await readAllWorkItems(q, fetchJson);
      if (latest.current === q) {
        setData(body);
        setError(undefined);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // A change of filter or page keeps the URL shareable.
  useEffect(() => {
    if (firstUrl.current) {
      firstUrl.current = false;
      return;
    }
    const s = pageSearch(query, page);
    window.history.replaceState(null, '', s ? `?${s}` : window.location.pathname);
  }, [query, page]);

  // A filter change reads again (the search after a pause); a page change does not, the rows are all here.
  useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [query, load]);

  // Progress on any item reads the ledger again, at most once a second; and every 20 seconds regardless.
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useChannels([WORK_ITEMS_CHANNEL], () => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = undefined;
      void load();
    }, 1000);
  });
  useEffect(() => {
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <section>
      <div className="view-head">
        <h1>Work items</h1>
        <p>Every turn the ledger holds, newest first, 50 to a page. Running items stay at the top.</p>
      </div>
      <div className="filters">
        <input
          className="search"
          type="search"
          placeholder="Search id, title, branch or PR"
          aria-label="Search work items"
          value={query.q}
          onChange={(e) => setState((s) => refine(s, { q: e.target.value }))}
        />
        <FilterChips
          label="Filter by state"
          options={FILTERS.map((f) => ({ value: f, label: FILTER_LABELS[f] }))}
          value={query.filter}
          onChange={(filter) => setState((s) => refine(s, { filter: isFilter(filter) ? filter : 'all' }))}
        />
        <span style={{ marginLeft: 'auto' }} className="note">
          Source:{' '}
          <select className="search" aria-label="Filter by source" value={query.source} onChange={(e) => setState((s) => refine(s, { source: e.target.value }))}>
            <option value="">any</option>
            {data.sources.map((s) => (
              <option key={s.type} value={s.type}>
                {s.label}
              </option>
            ))}
          </select>
        </span>
      </div>
      {error ? <div className="error-note" role="alert">{`Could not read the ledger: ${error}`}</div> : null}
      <div className="card flush">
        <WorkItemsTable items={data.items} empty={emptyMessage(query, data.sources)} paging={{ page, onPageChange: (p) => setState((s) => turnTo(s, p)) }} />
      </div>
      <p className="note">Refused turns are the system&apos;s only queue: a busy thread drops the turn, so the person must ask again once the holder finishes.</p>
    </section>
  );
}
