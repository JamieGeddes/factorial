/**
 * The pure decision function for events on Factorial's own pull requests.
 *
 * This is the seam where a triage agent can later replace the rules: one
 * function in, one decision out, no I/O. It maps a GitHub webhook event to
 * `ignore`, `rework-review` or `rework-checks-failed`, and the guards (PR
 * opened by the Factorial App on a `factorial/*` branch, trusted users only,
 * no bot comments) are applied here too, so every rule is unit-testable.
 */
import {
  parseCheckSuitePayload,
  parseIssueCommentPayload,
  parseReviewCommentPayload,
  parseReviewPayload,
  parseWorkflowRunPayload,
  type PullRequestRef,
} from './payloads.ts';

/** The outcome for one event. `reason` is for logging on ignore. */
export type PrEventDecision =
  | { kind: 'ignore'; reason: string }
  | {
      kind: 'rework-review';
      pullRequest: PullRequestRef;
      comment: { author: string; body: string; path?: string; line?: number };
    }
  | { kind: 'rework-checks-failed'; pullRequest: PullRequestRef; headSha: string };

export interface DecidePrOptions {
  /** The App's bot login, e.g. `my-factorial[bot]`. */
  botLogin: string;
  /** Numeric GitHub user IDs trusted to request rework. */
  allowedUserIds: ReadonlySet<number>;
}

/** At most this many automatic checks-failed reworks per PR without a human comment in between. */
export const MAX_AUTOMATIC_CHECKS_REWORKS = 2;

const FACTORIAL_COMMAND = /^\/factorial(\s|$)/;

/** Does the comment body mention the bot's login, without matching a longer login? */
export function mentionsBot(body: string, botLogin: string): boolean {
  const needle = botLogin.toLowerCase();
  const haystack = body.toLowerCase();
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const before = index === 0 ? '' : haystack[index - 1]!;
    const after = haystack[index + needle.length] ?? '';
    if (!/[a-z0-9-]/.test(before) && !/[a-z0-9-]/.test(after)) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

function isBot(actor: { login: string; type: string }, options: DecidePrOptions): boolean {
  return actor.type === 'Bot' || actor.login === options.botLogin || actor.login === `${options.botLogin}[bot]`;
}

function isTrusted(actor: { id: number } | undefined, options: DecidePrOptions): boolean {
  return actor !== undefined && options.allowedUserIds.has(actor.id);
}

/**
 * Decide what an event on a pull request means for Factorial.
 *
 * | Event | Decision |
 * |---|---|
 * | `pull_request_review` submitted with state `changes_requested` | `rework-review` |
 * | `pull_request_review_comment` / `issue_comment` on the PR mentioning the bot login or starting with `/factorial` | `rework-review` |
 * | `check_suite` / `workflow_run` completed with conclusion `failure` on the PR head | `rework-checks-failed` |
 * | Anything else, including plain comments | `ignore` |
 *
 * Every path is guarded: only PRs the Factorial App opened on a `factorial/*`
 * branch count, only trusted users can trigger rework, and bots — including
 * Factorial's own — never count.
 */
export function decidePrEvent(
  githubEvent: string,
  payload: unknown,
  options: DecidePrOptions,
): PrEventDecision {
  switch (githubEvent) {
    case 'pull_request_review':
      return decideReview(payload, options);
    case 'pull_request_review_comment':
      return decideReviewComment(payload, options);
    case 'issue_comment':
      return decideIssueComment(payload, options);
    case 'check_suite':
      return decideCheckSuite(payload, options);
    case 'workflow_run':
      return decideWorkflowRun(payload, options);
    default:
      return { kind: 'ignore', reason: `ignored event "${githubEvent}"` };
  }
}

function decideReview(payload: unknown, options: DecidePrOptions): PrEventDecision {
  const event = parseReviewPayload(payload);
  const guarded = guardPullRequest(event.pullRequest);
  if (guarded.kind === 'ignore') return guarded;
  if (event.action !== 'submitted' || event.review.state !== 'changes_requested') {
    return { kind: 'ignore', reason: `ignored review action "${event.action}" state "${event.review.state}"` };
  }
  if (isBot(event.sender, options)) {
    return { kind: 'ignore', reason: 'review from a bot' };
  }
  if (!isTrusted(event.sender, options)) {
    return { kind: 'ignore', reason: `review by untrusted user "${event.sender.login}"` };
  }
  return {
    kind: 'rework-review',
    pullRequest: guarded.pullRequest,
    comment: { author: event.sender.login, body: event.review.body ?? '' },
  };
}

function decideReviewComment(payload: unknown, options: DecidePrOptions): PrEventDecision {
  const event = parseReviewCommentPayload(payload);
  const guarded = guardPullRequest(event.pullRequest);
  if (guarded.kind === 'ignore') return guarded;
  if (!mentionsBot(event.comment.body, options.botLogin) && !FACTORIAL_COMMAND.test(event.comment.body)) {
    return { kind: 'ignore', reason: 'plain review comment' };
  }
  return trustedComment(guarded.pullRequest, event.sender, event.comment, options);
}

/**
 * Cheap pre-filter for `issue_comment` deliveries: is the comment body one
 * that could trigger rework? The handler fetches the PR record from the API
 * only when this passes, because `issue_comment` payloads carry no PR shape.
 */
export function isReworkRequestComment(body: string, botLogin: string): boolean {
  return mentionsBot(body, botLogin) || FACTORIAL_COMMAND.test(body);
}

/**
 * `issue_comment` decisions. GitHub's payload says only that the issue is a
 * PR (it carries `issue.pull_request.url`), so the handler enriches the
 * payload with the full PR record before calling this; without it there is
 * nothing to guard on, so the comment is ignored.
 */
function decideIssueComment(payload: unknown, options: DecidePrOptions): PrEventDecision {
  const event = parseIssueCommentPayload(payload);
  if (event.action !== 'created') {
    return { kind: 'ignore', reason: `ignored issue_comment action "${event.action}"` };
  }
  if (event.pullRequest === undefined) {
    return { kind: 'ignore', reason: 'comment is not on a pull request' };
  }
  if (!isReworkRequestComment(event.comment.body, options.botLogin)) {
    return { kind: 'ignore', reason: 'plain issue comment' };
  }
  return trustedComment(event.pullRequest, event.sender, event.comment, options);
}

function trustedComment(
  pullRequest: PullRequestRef,
  sender: { id: number; login: string; type: string },
  comment: { body: string; path?: string; line?: number },
  options: DecidePrOptions,
): PrEventDecision {
  if (isBot(sender, options)) {
    return { kind: 'ignore', reason: 'comment from a bot' };
  }
  if (!isTrusted(sender, options)) {
    return { kind: 'ignore', reason: `comment by untrusted user "${sender.login}"` };
  }
  return { kind: 'rework-review', pullRequest, comment: { ...comment, author: sender.login } };
}

function decideCheckSuite(payload: unknown, options: DecidePrOptions): PrEventDecision {
  const event = parseCheckSuitePayload(payload);
  if (event.action !== 'completed') {
    return { kind: 'ignore', reason: `ignored check_suite action "${event.action}"` };
  }
  return decideChecksFailure(event.pullRequests, event.checkSuite.conclusion, options);
}

function decideWorkflowRun(payload: unknown, options: DecidePrOptions): PrEventDecision {
  const event = parseWorkflowRunPayload(payload);
  if (event.action !== 'completed') {
    return { kind: 'ignore', reason: `ignored workflow_run action "${event.action}"` };
  }
  return decideChecksFailure(event.pullRequests, event.workflowRun.conclusion, options);
}

function decideChecksFailure(
  pullRequests: PullRequestRef[],
  conclusion: string | null,
  _options: DecidePrOptions,
): PrEventDecision {
  for (const pullRequest of pullRequests) {
    const guarded = guardPullRequest(pullRequest);
    if (guarded.kind === 'ignore') continue;
    if (conclusion !== 'failure') {
      return { kind: 'ignore', reason: `checks concluded "${conclusion ?? 'running'}"` };
    }
    return { kind: 'rework-checks-failed', pullRequest: guarded.pullRequest, headSha: guarded.pullRequest.head.sha };
  }
  return { kind: 'ignore', reason: 'no pull request from the Factorial App' };
}

/** Guard: only PRs on a `factorial/*` branch, authored by a bot (the App), count. */
function guardPullRequest(
  pullRequest: PullRequestRef,
): { kind: 'ignore'; reason: string } | { kind: 'ok'; pullRequest: PullRequestRef } {
  if (!pullRequest.head.ref.startsWith('factorial/')) {
    return { kind: 'ignore', reason: `head branch "${pullRequest.head.ref}" is not a factorial/* branch` };
  }
  if (pullRequest.user.type !== 'Bot') {
    return { kind: 'ignore', reason: `PR author "${pullRequest.user.login}" is not a GitHub App` };
  }
  return { kind: 'ok', pullRequest };
}
