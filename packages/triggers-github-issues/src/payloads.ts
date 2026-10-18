/**
 * Narrowed shapes of the GitHub webhook payloads the PR adapter relies on.
 * Parsing throws BadPayloadError on malformed payloads.
 */
import { BadPayloadError } from './issue-event.ts';

export interface PullRequestRef {
  number: number;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string; type: string };
}

export interface RepositoryRef {
  name: string;
  owner: { login: string };
}

interface User {
  id: number;
  login: string;
  type: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new BadPayloadError(`${path} must be a string`);
  return value;
}

function num(value: unknown, path: string): number {
  if (typeof value !== 'number') throw new BadPayloadError(`${path} must be a number`);
  return value;
}

function user(value: unknown, path: string): User {
  if (!isRecord(value)) throw new BadPayloadError(`${path} must be an object`);
  return { id: num(value.id, `${path}.id`), login: str(value.login, `${path}.login`), type: str(value.type, `${path}.type`) };
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === null || value === undefined ? undefined : str(value, path);
}

function repository(value: unknown): RepositoryRef {
  if (!isRecord(value) || !isRecord(value.owner)) throw new BadPayloadError('repository.owner must be an object');
  return { name: str(value.name, 'repository.name'), owner: { login: str(value.owner.login, 'repository.owner.login') } };
}

/**
 * A PR as it appears inside a webhook payload: `head.sha` is required except
 * for `pull_request_review_comment` deliveries, which omit it.
 */
function pullRequest(value: unknown, path: string, options: { requireHeadSha?: boolean } = {}): PullRequestRef {
  if (!isRecord(value)) throw new BadPayloadError(`${path} must be an object`);
  const head = isRecord(value.head) ? value.head : undefined;
  if (head === undefined || typeof head.ref !== 'string') throw new BadPayloadError(`${path}.head.ref must be a string`);
  if (head.sha !== undefined && typeof head.sha !== 'string') throw new BadPayloadError(`${path}.head.sha must be a string`);
  if (options.requireHeadSha !== false && typeof head.sha !== 'string') {
    throw new BadPayloadError(`${path}.head.sha must be a string`);
  }
  const base = isRecord(value.base) ? optionalString(value.base.ref, `${path}.base.ref`) : undefined;
  if (base === undefined) throw new BadPayloadError(`${path}.base.ref must be a string`);
  return {
    number: num(value.number, `${path}.number`),
    html_url: str(value.html_url, `${path}.html_url`),
    head: { ref: head.ref, sha: head.sha ?? '' },
    base: { ref: base },
    user: user(value.user, `${path}.user`),
  };
}

function pullRequests(value: unknown, path: string): PullRequestRef[] {
  return (Array.isArray(value) ? value : []).map((pr, i) => pullRequest(pr, `${path}[${i}]`));
}

export function parseReviewPayload(value: unknown): {
  action: string;
  review: { state: string; body: string | null };
  pullRequest: PullRequestRef;
  repository: RepositoryRef;
  sender: User;
} {
  if (!isRecord(value) || !isRecord(value.review)) throw new BadPayloadError('review must be an object');
  return {
    action: str(value.action, 'action'),
    review: {
      state: str(value.review.state, 'review.state'),
      body: optionalString(value.review.body, 'review.body') ?? null,
    },
    pullRequest: pullRequest(value.pull_request, 'pull_request'),
    repository: repository(value.repository),
    sender: user(value.sender, 'sender'),
  };
}

export function parseReviewCommentPayload(value: unknown): {
  action: string;
  comment: { body: string; path?: string; line?: number };
  pullRequest: PullRequestRef;
  repository: RepositoryRef;
  sender: User;
} {
  if (!isRecord(value) || !isRecord(value.comment)) throw new BadPayloadError('comment must be an object');
  const comment = value.comment;
  return {
    action: str(value.action, 'action'),
    comment: {
      body: str(comment.body, 'comment.body'),
      ...(comment.path === undefined ? {} : { path: str(comment.path, 'comment.path') }),
      ...(comment.line === undefined ? {} : { line: num(comment.line, 'comment.line') }),
    },
    pullRequest: pullRequest(value.pull_request, 'pull_request', { requireHeadSha: false }),
    repository: repository(value.repository),
    sender: user(value.sender, 'sender'),
  };
}

export function parseIssueCommentPayload(value: unknown): {
  action: string;
  issue: { number: number; html_url: string };
  /** The full PR record, present only when the handler enriched the payload (GitHub's own delivery has no PR shape). */
  pullRequest?: PullRequestRef;
  comment: { body: string };
  repository: RepositoryRef;
  sender: User;
} {
  if (!isRecord(value) || !isRecord(value.issue) || !isRecord(value.comment)) {
    throw new BadPayloadError('issue and comment must be objects');
  }
  return {
    action: str(value.action, 'action'),
    issue: { number: num(value.issue.number, 'issue.number'), html_url: str(value.issue.html_url, 'issue.html_url') },
    ...(value.pull_request === undefined
      ? {}
      : { pullRequest: pullRequest(value.pull_request, 'pull_request', { requireHeadSha: false }) }),
    comment: { body: str(value.comment.body, 'comment.body') },
    repository: repository(value.repository),
    sender: user(value.sender, 'sender'),
  };
}

export function parseCheckSuitePayload(value: unknown): {
  action: string;
  checkSuite: { conclusion: string | null };
  pullRequests: PullRequestRef[];
  repository: RepositoryRef;
} {
  if (!isRecord(value) || !isRecord(value.check_suite)) throw new BadPayloadError('check_suite must be an object');
  return {
    action: str(value.action, 'action'),
    checkSuite: {
      conclusion:
        value.check_suite.conclusion === null || value.check_suite.conclusion === undefined
          ? null
          : str(value.check_suite.conclusion, 'check_suite.conclusion'),
    },
    pullRequests: pullRequests(value.check_suite.pull_requests, 'check_suite.pull_requests'),
    repository: repository(value.repository),
  };
}

export function parseWorkflowRunPayload(value: unknown): {
  action: string;
  workflowRun: { conclusion: string | null };
  pullRequests: PullRequestRef[];
  repository: RepositoryRef;
} {
  if (!isRecord(value) || !isRecord(value.workflow_run)) throw new BadPayloadError('workflow_run must be an object');
  return {
    action: str(value.action, 'action'),
    workflowRun: {
      conclusion:
        value.workflow_run.conclusion === null || value.workflow_run.conclusion === undefined
          ? null
          : str(value.workflow_run.conclusion, 'workflow_run.conclusion'),
    },
    pullRequests: pullRequests(value.workflow_run.pull_requests, 'workflow_run.pull_requests'),
    repository: repository(value.repository),
  };
}
