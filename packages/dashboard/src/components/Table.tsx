'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MouseEvent, ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: string;
  align?: 'right';
  render(row: T): ReactNode;
}

/**
 * A table whose rows open a page: the first cell holds a real link (for the
 * keyboard and for opening in a new tab), and a click anywhere else on the
 * row follows it, unless it landed on another link.
 */
export function Table<T>({ columns, rows, rowKey, rowHref, empty, label }: { columns: Column<T>[]; rows: T[]; rowKey(row: T): string; rowHref?(row: T): string | undefined; empty: ReactNode; label: string }) {
  const router = useRouter();
  const open = (href: string | undefined) => (event: MouseEvent<HTMLTableRowElement>) => {
    if (!href || (event.target as HTMLElement).closest('a, button, summary')) return;
    if (event.metaKey || event.ctrlKey) window.open(href, '_blank', 'noopener');
    else router.push(href);
  };
  return (
    <table aria-label={label}>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} className={c.align === 'right' ? 'right' : undefined}>
              {c.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={columns.length} className="empty">
              {empty}
            </td>
          </tr>
        ) : (
          rows.map((row) => {
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
