import { randomUUID } from 'node:crypto';

import { TRIGGER_TYPES, validateWorkItem, type WorkItem } from '@factorial/workitem';

/** The subset of GitHub's `issues` webhook payload the adapter relies on. */
export interface IssuesWebhookPayload {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: { id: number; login: string };
  };
  label?: { name: string };
  repository: {
    name: string;
    owner: { login: string };
  };
  sender: { id: number; login: string };
}

export type IssueDecision =
  | { kind: 'ignore'; reason: string }
  | { kind: 'work'; workItem: WorkItem };

export interface DecideOptions {
  /** Label whose addition turns an issue into work. */
  triggerLabel: string;
  /**
   * Numeric GitHub user IDs trusted to request work. Both the issue author and
   * whoever applies the label must be in this set, because the issue body
   * becomes the agent's instructions. IDs, not logins, since a login can be
   * renamed and re-registered by someone else.
   */
  allowedUserIds: ReadonlySet<number>;
  /** GitHub's delivery GUID, reused as the WorkItem id so redeliveries are idempotent. */
  deliveryId: string | undefined;
  now?: Date;
}

export class BadPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadPayloadError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_MAX = 256;
const BODY_MAX = 65_536;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function user(value: unknown, path: string): { id: number; login: string } {
  if (!isRecord(value)) throw new BadPayloadError(`${path} must be an object`);
  if (typeof value.id !== 'number') throw new BadPayloadError(`${path}.id must be a number`);
  return { id: value.id, login: str(value.login, `${path}.login`) };
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new BadPayloadError(`${path} must be a string`);
  }
  return value;
}

/** Narrow an unknown JSON value to the payload shape, throwing BadPayloadError if it does not fit. */
export function parseIssuesPayload(value: unknown): IssuesWebhookPayload {
  if (!isRecord(value)) throw new BadPayloadError('payload must be an object');
  const { issue, repository, sender, label } = value;
  if (!isRecord(issue)) throw new BadPayloadError('issue must be an object');
  if (!isRecord(repository) || !isRecord(repository.owner)) {
    throw new BadPayloadError('repository.owner must be an object');
  }
  if (typeof issue.number !== 'number') throw new BadPayloadError('issue.number must be a number');
  if (issue.body !== null && issue.body !== undefined && typeof issue.body !== 'string') {
    throw new BadPayloadError('issue.body must be a string or null');
  }

  const parsed: IssuesWebhookPayload = {
    action: str(value.action, 'action'),
    issue: {
      number: issue.number,
      title: str(issue.title, 'issue.title'),
      body: (issue.body as string | null | undefined) ?? null,
      html_url: str(issue.html_url, 'issue.html_url'),
      user: user(issue.user, 'issue.user'),
    },
    repository: {
      name: str(repository.name, 'repository.name'),
      owner: { login: str(repository.owner.login, 'repository.owner.login') },
    },
    sender: user(sender, 'sender'),
  };
  if (isRecord(label)) {
    parsed.label = { name: str(label.name, 'label.name') };
  }
  return parsed;
}

/**
 * Decide what an `issues` webhook means for Factorial.
 *
 * Only the `labeled` action with the trigger label creates work. Creating an
 * issue with the label already applied fires both `opened` and `labeled`, so
 * reacting to `labeled` alone handles both cases exactly once.
 */
export function decideIssueEvent(payload: unknown, options: DecideOptions): IssueDecision {
  const event = parseIssuesPayload(payload);

  if (event.action !== 'labeled') {
    return { kind: 'ignore', reason: `ignored action "${event.action}"` };
  }
  if (event.label?.name !== options.triggerLabel) {
    return { kind: 'ignore', reason: `ignored label "${event.label?.name ?? ''}"` };
  }
  if (!options.allowedUserIds.has(event.sender.id)) {
    return { kind: 'ignore', reason: `label applied by untrusted user "${event.sender.login}"` };
  }
  if (!options.allowedUserIds.has(event.issue.user.id)) {
    return { kind: 'ignore', reason: `issue opened by untrusted user "${event.issue.user.login}"` };
  }

  const id =
    options.deliveryId !== undefined && UUID.test(options.deliveryId)
      ? options.deliveryId.toLowerCase()
      : randomUUID();

  const candidate = {
    schemaVersion: 1,
    id,
    source: {
      type: TRIGGER_TYPES.githubIssue,
      id: String(event.issue.number),
      url: event.issue.html_url,
    },
    repository: {
      provider: 'github',
      owner: event.repository.owner.login,
      name: event.repository.name,
    },
    title: event.issue.title.slice(0, TITLE_MAX),
    body: (event.issue.body ?? '').slice(0, BODY_MAX),
    requestedBy: event.sender.login,
    createdAt: (options.now ?? new Date()).toISOString(),
  };

  const result = validateWorkItem(candidate);
  if (!result.ok) {
    throw new BadPayloadError(`issue does not map to a valid WorkItem: ${result.errors.join('; ')}`);
  }
  return { kind: 'work', workItem: result.value };
}
