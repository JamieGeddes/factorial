import { FILTER_LABELS, matchesFilter, type Filter, type WorkItemSummary } from './work-items.ts';

/** What narrows the Run & transcript list: a status filter and a search. */
export interface RunsQuery {
  filter: Filter;
  q: string;
}

/** Search over reference, title and id. */
export function matchesRunSearch(item: WorkItemSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.source.ref, item.title, item.id].some((field) => field.toLowerCase().includes(q));
}

export function filterRuns(items: WorkItemSummary[], query: RunsQuery): WorkItemSummary[] {
  return items.filter((i) => matchesFilter(i, query.filter) && matchesRunSearch(i, query.q));
}

/** The empty state names what to clear. */
export function runsEmptyMessage(query: RunsQuery): string {
  const active: string[] = [];
  if (query.filter !== 'all') active.push(`the ${FILTER_LABELS[query.filter]} filter`);
  if (query.q.trim()) active.push(`the search “${query.q.trim()}”`);
  if (active.length === 0) return 'No item has an agent run yet.';
  const list = active.length === 1 ? active[0] : `${active.slice(0, -1).join(', ')} or ${active.at(-1)}`;
  return `No runs match. Clear ${list} to see more.`;
}
