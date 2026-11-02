import { RunsView } from '../../components/run/RunsView.tsx';
import { parsePage } from '../../lib/paging.ts';
import { isFilter } from '../../lib/work-items.ts';
import { runsPage } from '../../server/handlers.ts';
import { services } from '../../server/services.ts';

export const dynamic = 'force-dynamic';

const one = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? '') : (value ?? ''));

/** Every item's latest agent run, newest created first, sortable, filterable and paged (50 a page) in the browser: the way into Run & transcript without a link. `filter`, `q` and `page` in the URL open it on that view. */
export default async function RunsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const filter = one(params.filter);
  const query = { filter: isFilter(filter) ? filter : ('all' as const), q: one(params.q) };
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
  return <RunsView items={items} initialQuery={query} initialPage={parsePage(params.page)} />;
}
