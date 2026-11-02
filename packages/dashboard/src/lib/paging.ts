/** Paging in the browser: the pure parts, so the rules are testable without rendering. */

export const DEFAULT_PAGE_SIZE = 50;

/** How many pages `total` rows make; none for no rows. */
export function pageCount(total: number, size: number = DEFAULT_PAGE_SIZE): number {
  return total > 0 ? Math.ceil(total / Math.max(1, size)) : 0;
}

/** `page` brought into 1..count (1 when there are no pages). */
export function clampPage(page: number, count: number): number {
  return Math.min(Math.max(1, Math.trunc(page) || 1), Math.max(count, 1));
}

/** The `page` parameter: a positive whole number, otherwise page 1. */
export function parsePage(value: string | string[] | null | undefined): number {
  const text = Array.isArray(value) ? value[0] : value;
  if (!text || !/^\d+$/.test(text.trim())) return 1;
  const page = Number(text.trim());
  return Number.isSafeInteger(page) && page >= 1 ? page : 1;
}

/** The rows of one page (the page clamped to the pages there are). */
export function pageRows<T>(rows: T[], page: number, size: number = DEFAULT_PAGE_SIZE): T[] {
  const start = (clampPage(page, pageCount(rows.length, size)) - 1) * size;
  return rows.slice(start, start + size);
}

/** The 1-based range a page covers, and the page count. No rows gives 0-0. */
export function pageRange(total: number, page: number, size: number = DEFAULT_PAGE_SIZE): { from: number; to: number; count: number } {
  const count = pageCount(total, size);
  if (count === 0) return { from: 0, to: 0, count };
  const current = clampPage(page, count);
  return { from: (current - 1) * size + 1, to: Math.min(total, current * size), count };
}

/** “1-50 of 120”. */
export function rangeText(range: { from: number; to: number }, total: number): string {
  return `${range.from}-${range.to} of ${total}`;
}

/** `params` with `page` set, or removed for page 1 (the default needs no parameter). */
export function withPageParam(params: URLSearchParams, page: number): URLSearchParams {
  const next = new URLSearchParams(params);
  if (page > 1) next.set('page', String(Math.trunc(page)));
  else next.delete('page');
  return next;
}

/** What a list shows: its filters and the page of the result. */
export interface Listing<Q> {
  query: Q;
  page: number;
}

/** A change of filter returns to page 1. */
export function refine<Q>(state: Listing<Q>, change: Partial<Q>): Listing<Q> {
  return { query: { ...state.query, ...change }, page: 1 };
}

/** The same filters on another page. */
export function turnTo<Q>(state: Listing<Q>, page: number): Listing<Q> {
  return { query: state.query, page };
}
