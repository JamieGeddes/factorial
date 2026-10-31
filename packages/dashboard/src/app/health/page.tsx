import { HealthView } from '../../components/health/HealthView.tsx';
import { healthPage } from '../../server/handlers.ts';
import { services } from '../../server/services.ts';

export const dynamic = 'force-dynamic';

/** Health (#59): read once here, then from `/api/health` every minute. */
export default async function HealthPage() {
  let initial;
  try {
    initial = await healthPage(services());
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return (
      <section>
        <div className="view-head">
          <h1>Health</h1>
        </div>
        <div className="error-note" role="alert">{`Could not read the ledger: ${message.slice(0, 300)}. Check the AWS credentials the app was started with.`}</div>
      </section>
    );
  }
  return <HealthView initial={initial} />;
}
