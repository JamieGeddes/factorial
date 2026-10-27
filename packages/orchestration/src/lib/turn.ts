/**
 * What a work item says about the work it continues, read from the item
 * alone, with no I/O. An item continues a pull request through `inReplyTo`
 * (#163). The cause is interpretation, derived here from the source type,
 * which records what happened. The superseded rework `context` is refused
 * by Intake and read nowhere.
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
  if (workItem.inReplyTo?.kind === 'pull-request') {
    const { owner, name } = workItem.repository;
    return { number: workItem.inReplyTo.number, url: `https://github.com/${owner}/${name}/pull/${workItem.inReplyTo.number}` };
  }
  return undefined;
}

/** Why a turn on a pull request needs rework, or undefined when the item's source type does not say. */
export function reworkCause(workItem: WorkItem): WorkItemReworkCause | undefined {
  if (workItem.inReplyTo === undefined) return undefined;
  return CAUSE_BY_SOURCE[workItem.source.type];
}

/**
 * The points the item itself carries: one, what was said (its body), by
 * whoever said it. A review with no text has none, and its inline comments
 * are fetched when the session is seeded; so is an inline comment's file
 * and line.
 */
export function reworkDetails(workItem: WorkItem): WorkItemReviewDetail[] {
  const body = workItem.body.trim().slice(0, POINT_MAX);
  if (!body) return [];
  const author = reworkCause(workItem) === 'checks-failed' ? CHECKS_AUTHOR : workItem.requestedBy;
  return [{ author, body }];
}
