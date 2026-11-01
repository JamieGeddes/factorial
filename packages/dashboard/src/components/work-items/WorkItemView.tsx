'use client';

import { useRefreshed } from '../../client/refresh.tsx';
import { WorkItemDetail, type WorkItemDetailData } from './WorkItemDetail.tsx';

/** Progress that may change item `id`'s page: any for it, from Intake to the pull request's outcome. */
export const progressFor =
  (id: string) =>
  (message: Record<string, unknown>): boolean =>
    message.workItemId === id;

/**
 * The work item page, read again from `/api/work-items/{id}` when progress for
 * this item arrives on the live feed (a pull request opened, a stage ended),
 * and once a minute in case the feed missed it.
 */
export function WorkItemView({ initial }: { initial: WorkItemDetailData }) {
  const id = initial.row.workItemId;
  const { data, error } = useRefreshed<WorkItemDetailData>(`/api/work-items/${id}`, initial, { everyMs: 60_000, wants: progressFor(id) });
  return (
    <>
      {error ? <div className="error-note" role="alert">{`Could not read the work item: ${error}`}</div> : null}
      <WorkItemDetail detail={data} />
    </>
  );
}
