import type { WorkItemSummary } from '../../lib/work-items.ts';
import { RunsTable } from './RunsTable.tsx';

/** Every item's latest agent run, running first: the way into Run & transcript without a link. */
export function RunsView({ items }: { items: WorkItemSummary[] }) {
  return (
    <section>
      <div className="view-head">
        <h1>Run &amp; transcript</h1>
        <p>One agent run, live or finished. Choose one: running items first, then the newest.</p>
      </div>
      <div className="card flush">
        <RunsTable items={items} />
      </div>
    </section>
  );
}
