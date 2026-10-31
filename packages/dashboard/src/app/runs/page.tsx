import Link from 'next/link';

import { NotSetUp } from '../../components/NotSetUp.tsx';

export const dynamic = 'force-dynamic';

export default function RunsPage() {
  return (
    <section>
      <div className="view-head">
        <h1>Run &amp; transcript</h1>
        <p>One agent run, live or finished, with its stages, limits, usage, plan and transcript.</p>
      </div>
      <NotSetUp what="Run & transcript" issue={58}>
        Open a run from <Link href="/work-items">Work items</Link>; until #58 a row opens the item&apos;s detail.
      </NotSetUp>
    </section>
  );
}
