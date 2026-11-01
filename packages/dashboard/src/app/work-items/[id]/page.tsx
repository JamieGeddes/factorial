import { notFound } from 'next/navigation';

import { WorkItemView } from '../../../components/work-items/WorkItemView.tsx';
import { isWorkItemId } from '../../../server/artefacts.ts';
import { workItemDetail } from '../../../server/handlers.ts';
import { services } from '../../../server/services.ts';

export const dynamic = 'force-dynamic';

/** One work item: its row, thread and artefacts (`WorkItemDetail`), kept current from the live feed (`WorkItemView`). */
export default async function WorkItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isWorkItemId(id)) notFound();
  const detail = await workItemDetail(services(), id);
  if (!detail) notFound();
  return <WorkItemView initial={detail} />;
}
