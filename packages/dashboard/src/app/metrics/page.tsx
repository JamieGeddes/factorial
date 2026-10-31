import { MetricsView } from '../../components/metrics/MetricsView.tsx';
import { metricsPage } from '../../server/handlers.ts';
import { services } from '../../server/services.ts';

export const dynamic = 'force-dynamic';

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Metrics and cost (#59): read once here for the range and repository in the URL, then from `/api/metrics`. */
export default async function MetricsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  let initial;
  try {
    initial = await metricsPage(services(), { range: first(params.range) ?? null, repository: first(params.repository) ?? null });
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return (
      <section>
        <div className="view-head">
          <h1>Metrics and cost</h1>
        </div>
        <div className="error-note" role="alert">{`Could not read the ledger: ${message.slice(0, 300)}. Check the AWS credentials the app was started with.`}</div>
      </section>
    );
  }
  return <MetricsView initial={initial} />;
}
