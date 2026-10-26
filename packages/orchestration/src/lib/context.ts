import type { ReworkContext, WorkItem } from '@factorial/workitem';

import type { Attempt } from './resume.ts';
import type { ReworkPoint } from './rework-admission.ts';
import { assertGitBranch } from './shell.ts';

/** What the state machine carries from Prepare to every later step. */
export interface WorkContext {
  workItem: WorkItem;
  sessionId: string;
  branch: string;
  baseBranch: string;
  /**
   * The commit the work branch started from: the base branch tip for a new
   * item, the existing branch head for rework. Collect counts, bundles and
   * pushes only the commits above it.
   */
  baseCommit: string;
  factorialVersion: string;
  /** Which attempt at this source the item is: 1, or one more than the attempt it resumes. */
  attempt: number;
  /** `<workItemId>/<attempt>/` in the artefact store. */
  artefactPrefix: string;
  /** The earlier attempt this item resumes, if any; the builder's session is seeded with it too. */
  resumedFrom?: Attempt;
  /**
   * For rework: who raised each point in rework.md and where, numbered as
   * there, including a review's inline comments that the work item does not
   * carry. The reply on the pull request and the review re-request use it.
   */
  reworkPoints?: ReworkPoint[];
  /** For rework, the item that opened the pull request, from the ledger; the work item's own field is the branch name's guess. */
  previousWorkItemId?: string;
}

export function branchFor(workItem: WorkItem): string {
  return `factorial/${workItem.id}`;
}

/** The rework context, when this item reworks a previous item's pull request. */
export function reworkContext(workItem: WorkItem): ReworkContext | undefined {
  return workItem.context?.kind === 'rework' ? workItem.context : undefined;
}

/**
 * The branch this item's work happens on: the previous item's branch for
 * rework, a fresh branch otherwise.
 */
export function workBranchFor(workItem: WorkItem): string {
  const rework = reworkContext(workItem);
  return rework ? assertGitBranch(rework.branch, 'rework branch') : branchFor(workItem);
}

export function issueNumber(workItem: WorkItem): number | undefined {
  if (workItem.source.type !== 'github-issue') return undefined;
  const n = Number(workItem.source.id);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
