import { RunsTable } from '../../components/run/RunsTable.tsx';
import { compareItems, summarise } from '../../lib/work-items.ts';
import { services } from '../../server/services.ts';

export const dynamic = 'force-dynamic';

/** Every item's latest agent run, running first: the way into Run & transcript without a link. */
export default async function RunsPage() {
  const s = services();
  let items;
  try {
    const [rows, threads] = await Promise.all([s.ledger.list(), s.threads.all()]);
    items = rows
      .map((row) => summarise(row, row.threadKey ? threads.get(row.threadKey) : undefined, s.now()))
      .filter((i) => i.latestRun)
      .sort(compareItems)
      .slice(0, 50);
  } catch (error) {
    return (
      <section>
        <div className="view-head">
          <h1>Run &amp; transcript</h1>
        </div>
        <div className="error-note" role="alert">{`Could not read the ledger: ${error instanceof Error ? error.message : String(error)}. Check the AWS credentials the app was started with.`}</div>
      </section>
    );
  }
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
