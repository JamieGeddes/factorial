/**
 * Turn a rework decision into a WorkItem. Pure, apart from the id: the
 * WorkItem carries `context.kind: "rework"` with the review comments, or the
 * failing jobs' names, in `context.details`. Logs are not fetched here; the
 * orchestrator's Prepare step does that.
 */
import { randomUUID } from 'node:crypto';

import { TRIGGER_TYPES, validateWorkItem, type WorkItem, type WorkItemReviewDetail } from '@factorial/workitem';

import type { PrEventDecision } from './pr-event.ts';
import type { RepositoryRef } from './payloads.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_MAX = 256;
const BODY_MAX = 65_536;

export class BadPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadPayloadError';
  }
}

export interface BuildReworkOptions {
  repository: RepositoryRef;
  /** Needed for rework context. */
  baseBranch: string;
  /** The WorkItem whose PR is being reworked. */
  previousWorkItemId: string;
  /** The App's bot login, the requester of automatic checks-failed rework. */
  botLogin: string;
  /** Failing job names, for checks-failed items. */
  failingJobs?: { name: string; url: string }[];
  /** GitHub's delivery GUID, reused as the WorkItem id so redeliveries are idempotent. */
  deliveryId: string | undefined;
  now?: Date;
}

/**
 * Build the rework WorkItem for a decision. `decision` must be one of the two
 * rework kinds; the failing jobs are supplied by the caller for
 * `rework-checks-failed`, and review details come from the decision.
 */
export function buildReworkWorkItem(
  decision: Extract<PrEventDecision, { kind: 'rework-review' | 'rework-checks-failed' }>,
  additional: Array<{ author: string; body: string; path?: string; line?: number }>,
  options: BuildReworkOptions,
): WorkItem {
  const id =
    options.deliveryId !== undefined && UUID.test(options.deliveryId)
      ? options.deliveryId.toLowerCase()
      : randomUUID();
  const pr = decision.pullRequest;
  const isChecksFailed = decision.kind === 'rework-checks-failed';

  const details: WorkItemReviewDetail[] = isChecksFailed
    ? (options.failingJobs ?? []).slice(0, 50).map((job) => ({
        author: options.botLogin,
        body: `The check "${job.name}" failed.\n${job.url}`,
      }))
    : additional.some((detail) => detail.author === decision.comment.author && detail.body === decision.comment.body)
      ? additional
      : [...additional, decision.comment]
      .map((detail) => ({ ...detail, body: detail.body.slice(0, 8000) }))
      .slice(0, 50);

  const cause = isChecksFailed ? ('checks-failed' as const) : ('review' as const);
  const title = isChecksFailed
    ? `Rework PR #${pr.number}: fix failing checks`
    : `Rework PR #${pr.number}: address review comments`;
  const body = isChecksFailed
    ? `The checks on PR #${pr.number} failed (${options.failingJobs?.map((job) => job.name).join(', ') ?? 'unknown jobs'}). Rework the change on the PR's branch to make them pass.`
    : decision.comment.body.trim() ||
      `Address the review comments on PR #${pr.number}.`;

  const candidate = {
    schemaVersion: 1,
    id,
    source: {
      type: TRIGGER_TYPES.githubPrRework,
      id: String(pr.number),
      url: pr.html_url,
    },
    repository: {
      provider: 'github',
      owner: options.repository.owner.login,
      name: options.repository.name,
    },
    title: title.slice(0, TITLE_MAX),
    body: body.slice(0, BODY_MAX),
    requestedBy: isChecksFailed ? options.botLogin : decision.comment.author,
    createdAt: (options.now ?? new Date()).toISOString(),
    context: {
      kind: 'rework',
      pullRequest: { number: pr.number, url: pr.html_url },
      branch: pr.head.ref,
      baseBranch: options.baseBranch,
      previousWorkItemId: options.previousWorkItemId,
      cause,
      details,
    },
  } satisfies WorkItem;

  const result = validateWorkItem(candidate);
  if (!result.ok) {
    throw new BadPayloadError(`rework event does not map to a valid WorkItem: ${result.errors.join('; ')}`);
  }
  return result.value;

}

