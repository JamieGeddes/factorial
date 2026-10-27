/**
 * What a work item says about the work it continues, read from the item
 * alone, with no I/O. An item continues a pull request through `inReplyTo`,
 * or through the superseded rework `context` (#163). Both shapes give the
 * same facts, so nothing downstream of Intake needs to know which one came.
 *
 * The cause is interpretation: for an `inReplyTo` item it is derived here
 * from the source type, which records what happened.
 */
import { TRIGGER_TYPES, type WorkItem, type WorkItemReviewDetail, type WorkItemReworkCause } from '@factorial/workitem';

/** The cause each pull request source type stands for. A type not listed is one Factorial does not know how to answer. */
const CAUSE_BY_SOURCE: Readonly<Record<string, WorkItemReworkCause>> = {
  [TRIGGER_TYPES.githubPullRequestReview]: 'review',
  [TRIGGER_TYPES.githubPullRequestReviewComment]: 'review',
  [TRIGGER_TYPES.githubPullRequestComment]: 'comment',
  [TRIGGER_TYPES.githubWorkflowRun]: 'checks-failed',
};

/** Who a failed run's point is attributed to: no person wrote it. */
export const CHECKS_AUTHOR = 'github-actions';

/** A point's text is capped as the contract capped `context.details`. */
export const POINT_MAX = 8_000;

/** The pull request an item continues, or undefined for a new request. */
export function continuedPullRequest(workItem: WorkItem): { number: number; url: string } | undefined {
  if (workItem.context?.kind === 'rework') return workItem.context.pullRequest;
  if (workItem.inReplyTo?.kind === 'pull-request') {
    const { owner, name } = workItem.repository;
    return { number: workItem.inReplyTo.number, url: `https://github.com/${owner}/${name}/pull/${workItem.inReplyTo.number}` };
  }
  return undefined;
}

/** Why a turn on a pull request needs rework, or undefined when the item's source type does not say. */
export function reworkCause(workItem: WorkItem): WorkItemReworkCause | undefined {
  if (workItem.context?.kind === 'rework') return workItem.context.cause;
  if (workItem.inReplyTo === undefined) return undefined;
  return CAUSE_BY_SOURCE[workItem.source.type];
}

/**
 * The points the item itself carries. An `inReplyTo` item's one point is what
 * was said, its body, by whoever said it; a review with no text has none, and
 * its inline comments are fetched when the session is seeded. An inline
 * comment's file and line are fetched there too.
 */
export function reworkDetails(workItem: WorkItem): WorkItemReviewDetail[] {
  if (workItem.context?.kind === 'rework') return workItem.context.details;
  const body = workItem.body.trim().slice(0, POINT_MAX);
  if (!body) return [];
  const author = reworkCause(workItem) === 'checks-failed' ? CHECKS_AUTHOR : workItem.requestedBy;
  return [{ author, body }];
}

/** The branch the adapter named for the pull request; only the superseded `context` carries one. */
export function claimedBranch(workItem: WorkItem): string | undefined {
  return workItem.context?.kind === 'rework' ? workItem.context.branch : undefined;
}
