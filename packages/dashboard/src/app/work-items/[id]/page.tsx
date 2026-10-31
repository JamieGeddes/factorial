import { notFound } from 'next/navigation';

import { WorkItemDetail } from '../../../components/work-items/WorkItemDetail.tsx';
import { isWorkItemId } from '../../../server/artefacts.ts';
import { workItemDetail } from '../../../server/handlers.ts';
import { services } from '../../../server/services.ts';

export const dynamic = 'force-dynamic';

/** One work item: its row, thread and artefacts (`WorkItemDetail`). */
export default async function WorkItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isWorkItemId(id)) notFound();
  const detail = await workItemDetail(services(), id);
  if (!detail) notFound();
  return <WorkItemDetail detail={detail} />;
}
