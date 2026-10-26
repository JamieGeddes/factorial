import type { WorkItem, WorkItemReworkCause } from '@factorial/workitem';

import type { Attempt } from './resume.ts';
import type { ReworkPoint } from './rework-points.ts';

/**
 * A turn on a pull request Factorial opened, as Intake established it: from
 * the thread and GitHub, not from what the adapter guessed.
 */
export interface ReworkTurn {
  pullRequest: { number: number; url: string };
  cause: WorkItemReworkCause;
  /** The item that opened the pull request, from its thread. */
  previousWorkItemId: string;
  /** The branch the pull request targets, as GitHub reports it. */
  baseBranch: string;
}

/** What the state machine carries from Prepare to every later step. */
export interface WorkContext {
  workItem: WorkItem;
  /** The thread the item is a turn in, `<owner>/<name>#<branch>` (#163). */
  threadKey: string;
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
  /** Set when the item is a turn on a pull request Factorial opened. */
  rework?: ReworkTurn;
}

export function branchFor(workItem: WorkItem): string {
  return `factorial/${workItem.id}`;
}

export function issueNumber(workItem: WorkItem): number | undefined {
  if (workItem.source.type !== 'github-issue') return undefined;
  const n = Number(workItem.source.id);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
