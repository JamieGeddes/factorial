import type { ReactNode } from 'react';

/** A panel whose source does not exist yet: says so and names the issue that adds it, never invented numbers. */
export function NotSetUp({ what, issue, children }: { what: string; issue: number; children?: ReactNode }) {
  return (
    <div className="not-set-up" role="status">
      <b>{what}</b>: not set up yet, #{issue} adds it.
      {children ? <div className="note">{children}</div> : null}
    </div>
  );
}
