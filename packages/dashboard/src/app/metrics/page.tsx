import { NotSetUp } from '../../components/NotSetUp.tsx';

export const dynamic = 'force-dynamic';

export default function MetricsPage() {
  return (
    <section>
      <div className="view-head">
        <h1>Metrics and cost</h1>
        <p>Per role, per model and per stage, from the progress record and the invoker&apos;s run records.</p>
      </div>
      <NotSetUp what="Metrics and cost" issue={59} />
    </section>
  );
}
