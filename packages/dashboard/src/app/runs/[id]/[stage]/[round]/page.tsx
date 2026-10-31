import { notFound } from 'next/navigation';

import { RunView } from '../../../../../components/run/RunView.tsx';
import { runPage } from '../../../../../server/handlers.ts';
import { services } from '../../../../../server/services.ts';

export const dynamic = 'force-dynamic';

/** A run's shareable URL: `/runs/<id>/<stage>/<round>`, the channel `/factorial/runs/<id>/<stage>/<round>`. */
export default async function RunPage({ params }: { params: Promise<{ id: string; stage: string; round: string }> }) {
  const { id, stage, round } = await params;
  const n = Number(round);
  if (!Number.isInteger(n)) notFound();
  const detail = await runPage(services(), id, stage, n);
  if (!detail) notFound();
  // Keyed by run, so moving between runs starts each one's transcript afresh.
  return <RunView key={detail.channel} initial={detail} />;
}
