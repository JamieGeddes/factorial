/**
 * Whether a rework item may run. The trigger adapter sees only the webhook,
 * so Prepare decides here, with the pull request as GitHub reports it and the
 * ledger's record of earlier items for the same pull request:
 *
 * - The pull request must be open, opened by Factorial, from this repository
 *   and still headed by the branch the item names.
 * - One item at a time per pull request: a second would race the first, and
 *   the clean-room push would refuse it once the head moved.
 * - At most two automatic reworks after failed checks without a human
 *   asking in between, so a change that cannot pass does not loop.
 */
import type { PullRequestState, ReviewComment } from '@factorial/github-app';
import type { ReworkContext, WorkItemReviewDetail } from '@factorial/workitem';

/** Statuses after which an item no longer holds its pull request. Anything else is in flight. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'pr-opened',
  'pr-updated',
  'no-changes',
  'tests-failed',
  'failed',
  'invalid-plan',
  'not-eligible',
  'busy',
  'rework-limit',
  'covered-by-review',
]);

/** Statuses of items that were refused, which neither hold the pull request nor count as an attempt. */
export const REFUSED_STATUSES: ReadonlySet<string> = new Set(['not-eligible', 'busy', 'rework-limit', 'covered-by-review']);

/**
 * An item still not finished after this long is taken to have died without
 * reporting, so it no longer blocks its pull request. Longer than the most a
 * build can take (`MaxBuildRounds` sessions of 6,600 seconds) plus tests and
 * review.
 */
export const STALE_AFTER_MS = 8 * 60 * 60 * 1000;

export const MAX_AUTOMATIC_REWORKS = 2;

/** At most this many points reach rework.md and the reply, matching the contract's cap on details. */
export const MAX_REWORK_POINTS = 50;
const POINT_MAX = 8_000;

/** Why Factorial may not rework this pull request on this branch, or undefined when it may. */
export function pullRequestMismatch(pr: PullRequestState, rework: ReworkContext, botLogin: string): string | undefined {
  if (pr.state !== 'open') return `pull request #${pr.number} is ${pr.state}`;
  if (pr.authorLogin.toLowerCase() !== botLogin.toLowerCase()) return `pull request #${pr.number} was not opened by Factorial`;
  if (pr.headRepoId !== pr.baseRepoId) return `pull request #${pr.number} comes from another repository`;
  if (pr.headRef !== rework.branch) return `pull request #${pr.number} is on ${pr.headRef}, not ${rework.branch}`;
  return undefined;
}

/** An earlier item for the same pull request, as the ledger's source index and row give it. */
export interface EarlierItem {
  workItemId: string;
  status?: string;
  createdAt?: string;
  /** The rework cause from the item's WorkItem; read only when the limit needs it. */
  cause?: string;
}

export type Admission =
  | { ok: true }
  | { ok: false; status: 'busy' | 'rework-limit'; reason: string; reply?: string };

/** Whether `item` was accepted before `current`, ties broken by id so two simultaneous items never refuse each other. */
export function acceptedBefore(item: EarlierItem, current: { workItemId: string; createdAt: string }): boolean {
  if (!item.createdAt) return false;
  return item.createdAt < current.createdAt || (item.createdAt === current.createdAt && item.workItemId < current.workItemId);
}

/**
 * Admit or refuse a rework item, given the items for its pull request newest
 * first. Only items accepted before it count, so of two that arrive together
 * the first runs. A refusal after a human asked carries a reply for the pull
 * request; an automatic one is only recorded, since failed checks can arrive
 * while Factorial's own rework is still running.
 */
export function admitRework(
  current: { workItemId: string; createdAt: string; cause: ReworkContext['cause'] },
  earlier: readonly EarlierItem[],
  now: Date,
): Admission {
  const prior = earlier.filter((item) => item.workItemId !== current.workItemId && acceptedBefore(item, current));
  const running = prior.find(
    (item) => !TERMINAL_STATUSES.has(item.status ?? '') && now.getTime() - Date.parse(item.createdAt ?? '') < STALE_AFTER_MS,
  );
  if (running) {
    return {
      ok: false,
      status: 'busy',
      reason: `work item ${running.workItemId} is still running on this pull request`,
      ...(current.cause !== 'checks-failed'
        ? { reply: `Factorial is already working on this pull request (work item \`${running.workItemId}\`), so this request was not started. Ask again once it has replied.` }
        : {}),
    };
  }
  if (current.cause !== 'checks-failed') return { ok: true };

  let automatic = 0;
  for (const item of prior) {
    if (REFUSED_STATUSES.has(item.status ?? '')) continue;
    if (item.cause !== 'checks-failed') break;
    automatic += 1;
  }
  if (automatic < MAX_AUTOMATIC_REWORKS) return { ok: true };
  // Say it once: later failures refused for the same reason stay quiet.
  const alreadySaid = prior[0]?.status === 'rework-limit';
  return {
    ok: false,
    status: 'rework-limit',
    reason: `${automatic} automatic reworks after failed checks without a human asking in between`,
    ...(alreadySaid
      ? {}
      : {
          reply: `Factorial has already tried to fix the failing checks on this pull request ${MAX_AUTOMATIC_REWORKS} times without anyone asking in between, so it has not started again. Address it in a comment to have it try once more.`,
        }),
  };
}

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
