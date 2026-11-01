'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type MouseEvent, type ReactNode } from 'react';

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

/**
 * A table whose rows open a page: the first cell holds a real link (for the
 * keyboard and for opening in a new tab), and a click anywhere else on the
 * row follows it, unless it landed on another link.
 */
export function Table<T>({ columns, rows, rowKey, rowHref, empty, label, defaultSort }: { columns: Column<T>[]; rows: T[]; rowKey(row: T): string; rowHref?(row: T): string | undefined; empty: ReactNode; label: string; defaultSort?: SortState }) {
  const router = useRouter();
  const [sort, setSort] = useState<SortState | undefined>(defaultSort);
  const shown = sort ? sortRows(rows, columns, sort) : rows;
  const open = (href: string | undefined) => (event: MouseEvent<HTMLTableRowElement>) => {
    if (!href || (event.target as HTMLElement).closest('a, button, summary')) return;
    if (event.metaKey || event.ctrlKey) window.open(href, '_blank', 'noopener');
    else router.push(href);
  };
  return (
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
                <button type="button" className="th-sort" onClick={() => setSort(nextSort(sort, c.key))}>
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
}
