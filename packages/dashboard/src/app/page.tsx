import { OverviewView } from '../components/overview/OverviewView.tsx';
import { overviewPage } from '../server/handlers.ts';
import { services } from '../server/services.ts';

export const dynamic = 'force-dynamic';

/** Everything in flight (#58): read once here, then kept current from the live stream and the overview route. */
export default async function OverviewPage() {
  let initial;
  try {
    initial = await overviewPage(services());
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return (
      <section>
        <div className="view-head">
          <h1>Overview</h1>
        </div>
        <div className="error-note" role="alert">{`Could not read the ledger: ${message.slice(0, 300)}. Check the AWS credentials the app was started with.`}</div>
      </section>
    );
  }
  return <OverviewView initial={initial} />;
}
