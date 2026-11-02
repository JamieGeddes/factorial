'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type MouseEvent, type ReactNode } from 'react';

import { clampPage, DEFAULT_PAGE_SIZE, pageCount, pageRange, pageRows, rangeText } from '../lib/paging.ts';

export interface Column<T> {
  key: string;
  header: string;
  align?: 'right';
  render(row: T): ReactNode;
  /** What the column sorts by. A column without one can't be sorted. */
  sortValue?(row: T): string | number | null | undefined;
}

export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

const missing = (v: string | number | null | undefined): v is null | undefined => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));

function compareValues(a: string | number, b: string | number): number {
  return typeof a === 'number' && typeof b === 'number' ? a - b : collator.compare(String(a), String(b));
}

/**
 * The rows in sort order, as a copy. Strings compare with digit runs as
 * numbers (so #9 comes before #12). Rows without a value come last in either
 * direction, and ties keep their input order. No sort, an unknown key or a
 * column without `sortValue` leaves the input order.
 */
export function sortRows<T>(rows: T[], columns: Column<T>[], sort: SortState | undefined): T[] {
  const value = sort && columns.find((c) => c.key === sort.key)?.sortValue;
  if (!sort || !value) return rows.slice();
  const sign = sort.dir === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, v: value(row) }))
    .sort((a, b) => {
      if (missing(a.v) || missing(b.v)) return missing(a.v) ? (missing(b.v) ? a.index - b.index : 1) : -1;
      return sign * compareValues(a.v, b.v) || a.index - b.index;
    })
    .map((x) => x.row);
}

/** A click on a header: the same column reverses, another column sorts ascending. */
export function nextSort(current: SortState | undefined, key: string): SortState {
  return current?.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
}

/** A click on a header sorts, and a sort change returns to page 1. */
export function headerClick(current: SortState | undefined, key: string): { sort: SortState; page: 1 } {
  return { sort: nextSort(current, key), page: 1 };
}

/** Paging for a `Table`: the view owns the page (and so the URL); `size` defaults to 50. */
export interface Paging {
  page: number;
  onPageChange(page: number): void;
  size?: number;
}

/** Previous, Next and the range, announced as it changes. Nothing for one page or none. */
export function Pager({ label, total, page, size = DEFAULT_PAGE_SIZE, onPageChange }: { label: string; total: number; page: number; size?: number; onPageChange(page: number): void }) {
  const count = pageCount(total, size);
  if (count <= 1) return null;
  const current = clampPage(page, count);
  return (
    <nav className="pager" aria-label={`${label} pages`}>
      <button type="button" disabled={current <= 1} onClick={() => onPageChange(current - 1)}>
        Previous
      </button>
      <span className="pager-range" aria-live="polite" aria-atomic="true">
        {rangeText(pageRange(total, current, size), total)}
      </span>
      <button type="button" disabled={current >= count} onClick={() => onPageChange(current + 1)}>
        Next
      </button>
    </nav>
  );
}

/**
 * A table whose rows open a page: the first cell holds a real link (for the
 * keyboard and for opening in a new tab), and a click anywhere else on the
 * row follows it, unless it landed on another link. With `paging`, only one
 * page of the sorted rows renders, with the controls below the table.
 */
export function Table<T>({ columns, rows, rowKey, rowHref, empty, label, defaultSort, paging }: { columns: Column<T>[]; rows: T[]; rowKey(row: T): string; rowHref?(row: T): string | undefined; empty: ReactNode; label: string; defaultSort?: SortState; paging?: Paging }) {
  const router = useRouter();
  const [sort, setSort] = useState<SortState | undefined>(defaultSort);
  const sorted = sort ? sortRows(rows, columns, sort) : rows;
  const shown = paging ? pageRows(sorted, paging.page, paging.size) : sorted;
  const open = (href: string | undefined) => (event: MouseEvent<HTMLTableRowElement>) => {
    if (!href || (event.target as HTMLElement).closest('a, button, summary')) return;
    if (event.metaKey || event.ctrlKey) window.open(href, '_blank', 'noopener');
    else router.push(href);
  };
  const table = (
    <table aria-label={label}>
      <thead>
        <tr>
          {columns.map((c) => {
            const className = c.align === 'right' ? 'right' : undefined;
            if (!c.sortValue) {
              return (
                <th key={c.key} className={className}>
                  {c.header}
                </th>
              );
            }
            const active = sort?.key === c.key ? sort.dir : undefined;
            return (
              <th key={c.key} className={className} aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none'}>
                <button
                  type="button"
                  className="th-sort"
                  onClick={() => {
                    const next = headerClick(sort, c.key);
                    setSort(next.sort);
                    paging?.onPageChange(next.page);
                  }}
                >
                  {c.header}
                  {active ? <span aria-hidden="true">{active === 'asc' ? ' ▲' : ' ▼'}</span> : null}
                </button>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {shown.length === 0 ? (
          <tr>
            <td colSpan={columns.length} className="empty">
              {empty}
            </td>
          </tr>
        ) : (
          shown.map((row) => {
            const href = rowHref?.(row);
            return (
              <tr key={rowKey(row)} className={href ? 'row-link' : undefined} onClick={open(href)}>
                {columns.map((c, i) => (
                  <td key={c.key} className={c.align === 'right' ? 'right num' : undefined}>
                    {i === 0 && href ? (
                      <Link className="row-anchor" href={href}>
                        {c.render(row)}
                      </Link>
                    ) : (
                      c.render(row)
                    )}
                  </td>
                ))}
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
  if (!paging) return table;
  return (
    <>
      {table}
      <Pager label={label} total={rows.length} page={paging.page} size={paging.size ?? DEFAULT_PAGE_SIZE} onPageChange={paging.onPageChange} />
    </>
  );
}
