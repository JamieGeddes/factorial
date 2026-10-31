import { WorkItemsView, type Query } from '../../components/work-items/WorkItemsView.tsx';
import { workItemsPage } from '../../server/handlers.ts';
import { services } from '../../server/services.ts';
import { isFilter } from '../../lib/work-items.ts';

export const dynamic = 'force-dynamic';

const one = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? '') : (value ?? ''));

export default async function WorkItemsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const filter = one(params.filter);
  const query: Query = { filter: isFilter(filter) ? filter : 'all', source: one(params.source), q: one(params.q) };
  try {
    const initial = await workItemsPage(services(), { ...query, limit: '500' });
    return <WorkItemsView initial={initial} initialQuery={query} />;
  } catch (error) {
    return (
      <section>
        <div className="view-head">
          <h1>Work items</h1>
        </div>
        <div className="error-note" role="alert">{`Could not read the ledger: ${error instanceof Error ? error.message : String(error)}. Check the AWS credentials the app was started with.`}</div>
      </section>
    );
  }
}
