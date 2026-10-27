/**
 * The points a rework turn must address, and the comments and reviews its
 * source URL points at. Whether a turn may run at all is the thread's
 * policy (`thread-policy.ts`).
 */
import type { ReviewComment } from '@factorial/github-app';
import type { WorkItemReviewDetail } from '@factorial/workitem';

/** At most this many points reach rework.md and the reply, matching the contract's cap on details. */
export const MAX_REWORK_POINTS = 50;
const POINT_MAX = 8_000;

/** The comment id in a source URL that points at an inline comment (`…/pull/26#discussion_r5`). */
export function inlineCommentIdFromUrl(url: string): number | undefined {
  const match = /#discussion_r([1-9][0-9]{0,15})$/.exec(url);
  return match ? Number(match[1]) : undefined;
}

/** A comment that can carry a reaction: one in the conversation, or one inline on the diff. */
export interface CommentRef {
  kind: 'conversation' | 'inline';
  id: number;
}

/** The comment a source URL points at, if it points at one (a review or a workflow run does not). */
export function commentToAcknowledge(url: string): CommentRef | undefined {
  const conversation = /#issuecomment-([1-9][0-9]{0,15})$/.exec(url);
  if (conversation) return { kind: 'conversation', id: Number(conversation[1]) };
  const inline = inlineCommentIdFromUrl(url);
  return inline === undefined ? undefined : { kind: 'inline', id: inline };
}

/** The review id in a source URL that points at a review (`…/pull/26#pullrequestreview-77`). */
export function reviewIdFromUrl(url: string): number | undefined {
  const match = /#pullrequestreview-([1-9][0-9]{0,15})$/.exec(url);
  return match ? Number(match[1]) : undefined;
}

/**
 * The points to address: the work item's own details, then the inline
 * comments of the review it came from (not in the webhook, so fetched here),
 * leaving out bots' comments. Capped as the contract caps details.
 */
export function reworkPoints(details: readonly WorkItemReviewDetail[], reviewComments: readonly ReviewComment[] = []): WorkItemReviewDetail[] {
  const fetched = reviewComments
    .filter((c) => c.authorType !== 'Bot' && !c.authorLogin.endsWith('[bot]') && c.body.trim())
    .map((c) => ({ author: c.authorLogin, path: c.path, ...(c.line && c.line > 0 ? { line: c.line } : {}), body: c.body.trim().slice(0, POINT_MAX) }));
  return [...details, ...fetched].slice(0, MAX_REWORK_POINTS);
}

/** Who raised a point and where, without what they said: all the reply and the re-request need, small enough for the state. */
export interface ReworkPoint {
  author: string;
  path?: string;
  line?: number;
}

export function pointOrigins(points: readonly WorkItemReviewDetail[]): ReworkPoint[] {
  return points.map((p) => ({ author: p.author.slice(0, 100), ...(p.path ? { path: p.path.slice(0, 300) } : {}), ...(p.line !== undefined ? { line: p.line } : {}) }));
}
