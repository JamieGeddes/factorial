import Link from 'next/link';
import { notFound } from 'next/navigation';

import { NotSetUp } from '../../../../../components/NotSetUp.tsx';
import { parseChannel } from '../../../../../server/live.ts';

export const dynamic = 'force-dynamic';

/** A run's shareable URL: `/runs/<id>/<stage>/<round>`, the channel `/factorial/runs/<id>/<stage>/<round>`. */
export default async function RunPage({ params }: { params: Promise<{ id: string; stage: string; round: string }> }) {
  const { id, stage, round } = await params;
  if (parseChannel(`/factorial/runs/${id}/${stage}/${round}`)?.kind !== 'run') notFound();
  return (
    <section>
      <div className="view-head">
        <h1>{`Run ${id.slice(0, 8)} · ${stage}/${round}`}</h1>
      </div>
      <NotSetUp what="Run & transcript" issue={58}>
        <Link href={`/work-items/${id}`}>Open the work item</Link> for its stages, live record and artefacts.
      </NotSetUp>
    </section>
  );
}
