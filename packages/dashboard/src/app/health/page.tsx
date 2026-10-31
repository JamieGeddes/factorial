import { NotSetUp } from '../../components/NotSetUp.tsx';

export const dynamic = 'force-dynamic';

export default function HealthPage() {
  return (
    <section>
      <div className="view-head">
        <h1>Health</h1>
        <p>Every component the pipeline depends on, with what it reported last.</p>
      </div>
      <NotSetUp what="Health: components, alarms, quotas, deploys and webhook deliveries" issue={59} />
    </section>
  );
}
