import { RunsView } from '../../components/run/RunsView.tsx';
import { runsPage } from '../../server/handlers.ts';
import { services } from '../../server/services.ts';

export const dynamic = 'force-dynamic';

/** Every item's latest agent run, running first: the way into Run & transcript without a link. */
export default async function RunsPage() {
  let items;
  try {
    items = await runsPage(services());
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
  return <RunsView items={items} />;
}
