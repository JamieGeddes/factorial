import Link from 'next/link';

import { NotSetUp } from '../components/NotSetUp.tsx';

export const dynamic = 'force-dynamic';

export default function OverviewPage() {
  return (
    <section>
      <div className="view-head">
        <h1>Overview</h1>
        <p>Everything in flight across the factory, refreshed from the live channel.</p>
      </div>
      <NotSetUp what="Overview: tiles, stage graph, sessions running, throughput, stage durations and spend" issue={58}>
        Until then, <Link href="/work-items?filter=running">Work items, Running</Link> lists what is in flight.
      </NotSetUp>
    </section>
  );
}
