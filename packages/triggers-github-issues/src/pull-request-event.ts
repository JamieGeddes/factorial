/**
 * Events on Factorial's own pull requests that become work items.
 *
 * `decidePullRequestEvent` maps a webhook to a work item or to nothing. It
 * records facts only (#163): what happened (the source type: a review, an
 * inline comment, a conversation comment, a failed workflow run), who said
 * what, and which pull request it continues (`inReplyTo`). What the event
 * means, which branch it is on and which item opened the pull request are
 * decided by Intake, from the thread and GitHub.
 *
 * The adapter is public-facing, holds no GitHub credentials and cannot read
 * the ledger, so it filters only on what the payload shows: trusted people,
 * no bots, a request addressed to the App, an open pull request the App
 * opened from a `factorial/` branch. Intake checks the rest and applies the
 * thread policies.
 */
import { randomUUID } from 'node:crypto';

import { TRIGGER_TYPES, validateWorkItem, type WorkItem } from '@factorial/workitem';

import { BadPayloadError } from './issue-event.ts';

export type PullRequestDecision = { kind: 'ignore'; reason: string } | { kind: 'emit'; workItem: WorkItem };

export interface PullRequestDecideOptions {
  /** The App's slug: its bot user is `<slug>[bot]`, and people address it as `@<slug>`. */
  appSlug: string;
  /** Numeric GitHub user IDs trusted to ask for work, as for issues. */
  allowedUserIds: ReadonlySet<number>;
  /** GitHub's delivery GUID, reused as the WorkItem id so redeliveries are idempotent. */
  deliveryId: string | undefined;
  now?: Date;
}

/** The webhook events this module decides on; any other goes to the issue adapter or is ignored. */
export const PULL_REQUEST_EVENTS = ['pull_request_review', 'pull_request_review_comment', 'issue_comment', 'workflow_run'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORK_BRANCH = /^factorial\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_MAX = 256;
const BODY_MAX = 65_536;

interface User {
  id: number;
  login: string;
  type: string;
}

interface Repository {
  id: number;
  name: string;
  owner: string;
}

/** A pull request as the review events carry it. */
interface PullRequest {
  number: number;
  title: string;
  state: string;
  author: User;
  headRef: string;
  headRepoId: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function rec(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new BadPayloadError(`${path} must be an object`);
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new BadPayloadError(`${path} must be a string`);
  return value;
}

function num(value: unknown, path: string): number {
  if (typeof value !== 'number') throw new BadPayloadError(`${path} must be a number`);
  return value;
}

function optionalText(value: unknown, path: string): string {
  if (value === null || value === undefined) return '';
  return str(value, path);
}

function user(value: unknown, path: string): User {
  const u = rec(value, path);
  return { id: num(u.id, `${path}.id`), login: str(u.login, `${path}.login`), type: typeof u.type === 'string' ? u.type : 'User' };
}

function repository(value: unknown): Repository {
  const r = rec(value, 'repository');
  return {
    id: num(r.id, 'repository.id'),
    name: str(r.name, 'repository.name'),
    owner: str(rec(r.owner, 'repository.owner').login, 'repository.owner.login'),
  };
}

function pullRequest(value: unknown): PullRequest {
  const pr = rec(value, 'pull_request');
  const head = rec(pr.head, 'pull_request.head');
  return {
    number: num(pr.number, 'pull_request.number'),
    title: str(pr.title, 'pull_request.title'),
    state: str(pr.state, 'pull_request.state'),
    author: user(pr.user, 'pull_request.user'),
    headRef: str(head.ref, 'pull_request.head.ref'),
    headRepoId: isRecord(head.repo) && typeof head.repo.id === 'number' ? head.repo.id : undefined,
  };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The request in a comment addressed to the App: the text after a mention of
 * `@<slug>` as the comment's first token. Undefined when the comment does not
 * start with the mention, which is the only way to address it.
 */
export function addressedRequest(body: string, appSlug: string): string | undefined {
  const match = new RegExp(`^\\s*@${escapeRegExp(appSlug)}(?![A-Za-z0-9-])[\\s,:]*`, 'i').exec(body);
  return match ? body.slice(match[0].length).trim() : undefined;
}

/** Why a person cannot ask for work, or undefined when they can. Bots never count, Factorial's own comments included. */
function untrusted(actor: User, options: PullRequestDecideOptions): string | undefined {
  if (actor.type === 'Bot' || actor.login.endsWith('[bot]')) return `ignored bot "${actor.login}"`;
  if (!options.allowedUserIds.has(actor.id)) return `untrusted user "${actor.login}"`;
  return undefined;
}

/** Why a pull request is not one of Factorial's open ones, or undefined when it is. */
function notFactorials(pr: PullRequest, repo: Repository, appSlug: string): string | undefined {
  if (pr.state !== 'open') return `pull request #${pr.number} is ${pr.state}`;
  if (pr.author.login.toLowerCase() !== `${appSlug}[bot]`.toLowerCase()) return `pull request #${pr.number} was not opened by Factorial`;
  if (!WORK_BRANCH.test(pr.headRef)) return `pull request #${pr.number} is not on a Factorial work branch`;
  if (pr.headRepoId !== repo.id) return `pull request #${pr.number} comes from another repository`;
  return undefined;
}

/** What happened on a pull request, as the payload shows it. */
interface PullRequestEvent {
  type: (typeof TRIGGER_TYPES)[keyof typeof TRIGGER_TYPES];
  /** The record's own id: the review, comment or workflow run. */
  id: number;
  url: string;
  repo: Repository;
  prNumber: number;
  title: string;
  /** What was said, or for a failed run what failed. May be empty. */
  body: string;
  requestedBy: string;
}

function workItemFor(event: PullRequestEvent, options: PullRequestDecideOptions): WorkItem {
  const id = options.deliveryId !== undefined && UUID.test(options.deliveryId) ? options.deliveryId.toLowerCase() : randomUUID();
  const candidate = {
    schemaVersion: 1,
    id,
    source: { type: event.type, id: String(event.id), url: event.url },
    repository: { provider: 'github', owner: event.repo.owner, name: event.repo.name },
    inReplyTo: { kind: 'pull-request', number: event.prNumber },
    title: event.title.slice(0, TITLE_MAX),
    body: event.body.slice(0, BODY_MAX),
    requestedBy: event.requestedBy,
    createdAt: (options.now ?? new Date()).toISOString(),
  };
  const result = validateWorkItem(candidate);
  if (!result.ok) throw new BadPayloadError(`event does not map to a valid WorkItem: ${result.errors.join('; ')}`);
  return result.value;
}

const emit = (event: PullRequestEvent, options: PullRequestDecideOptions): PullRequestDecision => ({ kind: 'emit', workItem: workItemFor(event, options) });

/**
 * A review submitted with "Request changes". Its text is the body, empty
 * when the reviewer wrote none; its inline comments are not in the webhook,
 * so Prepare fetches them, keyed by the review id in the source URL.
 */
function fromReview(payload: Record<string, unknown>, options: PullRequestDecideOptions): PullRequestDecision {
  const action = str(payload.action, 'action');
  if (action !== 'submitted') return { kind: 'ignore', reason: `ignored review action "${action}"` };
  const review = rec(payload.review, 'review');
  const state = str(review.state, 'review.state').toLowerCase();
  if (state !== 'changes_requested') return { kind: 'ignore', reason: `ignored review in state "${state}"` };
  const reviewer = user(review.user, 'review.user');
  const sender = user(payload.sender, 'sender');
  const repo = repository(payload.repository);
  const pr = pullRequest(payload.pull_request);
  const refused = untrusted(sender, options) ?? untrusted(reviewer, options) ?? notFactorials(pr, repo, options.appSlug);
  if (refused) return { kind: 'ignore', reason: refused };
  return emit(
    {
      type: TRIGGER_TYPES.githubPullRequestReview,
      id: num(review.id, 'review.id'),
      url: str(review.html_url, 'review.html_url'),
      repo,
      prNumber: pr.number,
      title: `Review of #${pr.number}: ${pr.title}`,
      body: optionalText(review.body, 'review.body').trim(),
      requestedBy: reviewer.login,
    },
    options,
  );
}

/** An inline comment on the diff that addresses the App. */
function fromReviewComment(payload: Record<string, unknown>, options: PullRequestDecideOptions): PullRequestDecision {
  const action = str(payload.action, 'action');
  if (action !== 'created') return { kind: 'ignore', reason: `ignored review comment action "${action}"` };
  const comment = rec(payload.comment, 'comment');
  const request = addressedRequest(str(comment.body, 'comment.body'), options.appSlug);
  if (request === undefined) return { kind: 'ignore', reason: 'review comment does not address Factorial' };
  if (!request) return { kind: 'ignore', reason: 'review comment addresses Factorial without a request' };
  const author = user(comment.user, 'comment.user');
  const sender = user(payload.sender, 'sender');
  const repo = repository(payload.repository);
  const pr = pullRequest(payload.pull_request);
  const refused = untrusted(sender, options) ?? untrusted(author, options) ?? notFactorials(pr, repo, options.appSlug);
  if (refused) return { kind: 'ignore', reason: refused };
  // Prepare fetches the file and line from the comment the source URL names.
  return emit(
    {
      type: TRIGGER_TYPES.githubPullRequestReviewComment,
      id: num(comment.id, 'comment.id'),
      url: str(comment.html_url, 'comment.html_url'),
      repo,
      prNumber: pr.number,
      title: `Comment on #${pr.number}: ${pr.title}`,
      body: request,
      requestedBy: author.login,
    },
    options,
  );
}

/**
 * A comment in the pull request's conversation that addresses the App. The
 * payload describes the pull request as an issue, without its branches;
 * Intake finds the branch from the pull request's thread.
 */
function fromIssueComment(payload: Record<string, unknown>, options: PullRequestDecideOptions): PullRequestDecision {
  const action = str(payload.action, 'action');
  if (action !== 'created') return { kind: 'ignore', reason: `ignored comment action "${action}"` };
  const issue = rec(payload.issue, 'issue');
  if (!isRecord(issue.pull_request)) return { kind: 'ignore', reason: 'comment is on an issue, not a pull request' };
  const comment = rec(payload.comment, 'comment');
  const request = addressedRequest(str(comment.body, 'comment.body'), options.appSlug);
  if (request === undefined) return { kind: 'ignore', reason: 'comment does not address Factorial' };
  if (!request) return { kind: 'ignore', reason: 'comment addresses Factorial without a request' };
  const author = user(comment.user, 'comment.user');
  const sender = user(payload.sender, 'sender');
  const repo = repository(payload.repository);
  const number = num(issue.number, 'issue.number');
  const prAuthor = user(issue.user, 'issue.user');
  const refused = untrusted(sender, options) ?? untrusted(author, options);
  if (refused) return { kind: 'ignore', reason: refused };
  const state = str(issue.state, 'issue.state');
  if (state !== 'open') return { kind: 'ignore', reason: `pull request #${number} is ${state}` };
  if (prAuthor.login.toLowerCase() !== `${options.appSlug}[bot]`.toLowerCase()) {
    return { kind: 'ignore', reason: `pull request #${number} was not opened by Factorial` };
  }
  return emit(
    {
      type: TRIGGER_TYPES.githubPullRequestComment,
      id: num(comment.id, 'comment.id'),
      url: str(comment.html_url, 'comment.html_url'),
      repo,
      prNumber: number,
      title: `Comment on #${number}: ${str(issue.title, 'issue.title')}`,
      body: request,
      requestedBy: author.login,
    },
    options,
  );
}

/**
 * A workflow run that failed on a Factorial pull request's head commit.
 * Factorial's own test workflow is dispatched on the default branch and is
 * not tied to a pull request, so it never matches.
 */
function fromWorkflowRun(payload: Record<string, unknown>, options: PullRequestDecideOptions): PullRequestDecision {
  const action = str(payload.action, 'action');
  if (action !== 'completed') return { kind: 'ignore', reason: `ignored workflow run action "${action}"` };
  const run = rec(payload.workflow_run, 'workflow_run');
  const conclusion = typeof run.conclusion === 'string' ? run.conclusion : 'none';
  if (conclusion !== 'failure') return { kind: 'ignore', reason: `ignored workflow run concluding "${conclusion}"` };
  const event = str(run.event, 'workflow_run.event');
  if (event !== 'push' && event !== 'pull_request') return { kind: 'ignore', reason: `ignored workflow run for "${event}"` };
  const repo = repository(payload.repository);
  const headRepo = isRecord(run.head_repository) && typeof run.head_repository.id === 'number' ? run.head_repository.id : undefined;
  if (headRepo !== repo.id) return { kind: 'ignore', reason: 'workflow run is for another repository' };
  const headBranch = str(run.head_branch, 'workflow_run.head_branch');
  if (!WORK_BRANCH.test(headBranch)) return { kind: 'ignore', reason: 'workflow run is not on a Factorial work branch' };
  const headSha = str(run.head_sha, 'workflow_run.head_sha');
  const prs = Array.isArray(run.pull_requests) ? run.pull_requests.filter(isRecord) : [];
  const pr = prs.find((p) => isRecord(p.head) && p.head.ref === headBranch && p.head.sha === headSha);
  if (!pr) return { kind: 'ignore', reason: 'workflow run is not on the head of an open pull request' };
  // The run's logs become the builder's instructions, so whoever caused it
  // must be trusted too: the App (its own push) or an allowed person. A
  // collaborator outside the list who pushes to the branch, or re-runs a
  // workflow, does not get to steer the rework.
  for (const field of ['actor', 'triggering_actor'] as const) {
    if (run[field] === undefined || run[field] === null) continue;
    const who = user(run[field], `workflow_run.${field}`);
    const isApp = who.login.toLowerCase() === `${options.appSlug}[bot]`.toLowerCase();
    if (!isApp && (who.type === 'Bot' || !options.allowedUserIds.has(who.id))) {
      return { kind: 'ignore', reason: `workflow run caused by untrusted ${who.type === 'Bot' ? 'bot' : 'user'} "${who.login}"` };
    }
  }
  const number = num(pr.number, 'workflow_run.pull_requests.number');
  const name = str(run.name, 'workflow_run.name');
  const runUrl = str(run.html_url, 'workflow_run.html_url');
  const actor = isRecord(run.triggering_actor) ? run.triggering_actor : run.actor;
  return emit(
    {
      type: TRIGGER_TYPES.githubWorkflowRun,
      id: num(run.id, 'workflow_run.id'),
      url: runUrl,
      repo,
      prNumber: number,
      title: `The workflow "${name}" failed on #${number}`,
      body: `The workflow "${name}" failed on ${headSha.slice(0, 12)}: ${runUrl}`,
      requestedBy: isRecord(actor) && typeof actor.login === 'string' && actor.login ? actor.login : `${options.appSlug}[bot]`,
    },
    options,
  );
}

/** Map a webhook on a pull request to a decision. Throws BadPayloadError for a payload that does not fit. */
export function decidePullRequestEvent(eventName: string, payload: unknown, options: PullRequestDecideOptions): PullRequestDecision {
  const value = rec(payload, 'payload');
  switch (eventName) {
    case 'pull_request_review':
      return fromReview(value, options);
    case 'pull_request_review_comment':
      return fromReviewComment(value, options);
    case 'issue_comment':
      return fromIssueComment(value, options);
    case 'workflow_run':
      return fromWorkflowRun(value, options);
    default:
      return { kind: 'ignore', reason: `ignored event "${eventName}"` };
  }
}
