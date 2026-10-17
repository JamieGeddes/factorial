import type { WorkItem } from '@factorial/workitem';

/** What the state machine carries from Prepare to every later step. */
export interface WorkContext {
  workItem: WorkItem;
  sessionId: string;
  branch: string;
  baseBranch: string;
  factorialVersion: string;
}

export function branchFor(workItem: WorkItem): string {
  return `factorial/${workItem.id}`;
}

export function issueNumber(workItem: WorkItem): number | undefined {
  if (workItem.source.type !== 'github-issue') return undefined;
  const n = Number(workItem.source.id);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
