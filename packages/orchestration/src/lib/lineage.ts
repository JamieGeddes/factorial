import type { WorkItem } from '@factorial/workitem';

/** The lineage attributes on a ledger row, flattened so the group and parent indexes can key on them. */
export interface LineageAttributes {
  groupId?: string;
  groupSize?: number;
  groupIndex?: number;
  parentId?: string;
}

/** Only the fields the WorkItem carries; an item without lineage gets none. */
export function lineageAttributes(workItem: WorkItem): LineageAttributes {
  return {
    ...(workItem.group ? { groupId: workItem.group.id, groupSize: workItem.group.size, groupIndex: workItem.group.index } : {}),
    ...(workItem.parentId ? { parentId: workItem.parentId } : {}),
  };
}
