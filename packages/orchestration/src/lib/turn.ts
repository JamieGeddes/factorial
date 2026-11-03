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

/** The issue an item continues, when it was said in an issue's conversation (#169), or undefined. */
export function continuedIssue(workItem: WorkItem): { number: number; url: string } | undefined {
  if (workItem.inReplyTo?.kind !== 'issue') return undefined;
  const { owner, name } = workItem.repository;
  return { number: workItem.inReplyTo.number, url: `https://github.com/${owner}/${name}/issues/${workItem.inReplyTo.number}` };
}

/**
 * What a comment in an issue's conversation asks for (#169), read from what
 * was said after the mention: a plan (`plan` or `plan this`), the approval
 * of the proposed plan (`approve`), or a revision of it (`revise`, then the
 * change wanted, after a colon or on the same line). Case is ignored, and so
 * is anything after `approve` or `plan this` on the first line. Anything else
 * is not understood: Intake refuses it and says what is.
 */
export type IssueCommand = { kind: 'plan' } | { kind: 'approve' } | { kind: 'revise'; request: string } | { kind: 'unknown' };

export function issueCommand(body: string): IssueCommand {
  const text = body.trim();
  const revise = /^revise\b[ \t]*:?\s*([\s\S]*)$/i.exec(text);
  if (revise) {
    const request = (revise[1] ?? '').trim();
    return request ? { kind: 'revise', request } : { kind: 'unknown' };
  }
  const first = (text.split('\n')[0] ?? '').trim();
  if (/^plan(?:\s+(?:this|it))?\b/i.test(first)) return { kind: 'plan' };
  if (/^approve\b/i.test(first)) return { kind: 'approve' };
  return { kind: 'unknown' };
}

/** What Intake says to a comment it does not understand, or to an approval or revision with no plan to act on. `slug` is the App's. */
export function issueCommandHelp(slug: string): string {
  return [
    `On an issue, Factorial understands:`,
    '',
    `- \`@${slug} plan this\`: propose a plan for this issue, changing nothing.`,
    `- \`@${slug} approve\`: build the plan last proposed here.`,
    `- \`@${slug} revise: <what to change>\`: propose a revised plan.`,
  ].join('\n');
}
