/**
 * Deliver an outcome to a GitHub source (#165): one comment where the
 * request came from, and on a rework the review re-request. The comment is
 * built from the outcome's pointers and the attempt's `report.json`, the
 * only artefact the reporter reads.
 *
 * Delivery never changes the turn's status: the outcome was recorded before
 * it was emitted. It is idempotent per outcome (`lib/delivery-ledger.ts`),
 * and every comment carries a marker naming the work item, so an attempt
 * that takes over an earlier one's claim can see whether that one posted.
 */
import { redactSecrets } from '@factorial/artefacts';
import type { TokenPermissions } from '@factorial/github-app';
import type { Outcome } from '@factorial/outcome';
import { TRIGGER_TYPES } from '@factorial/workitem';

import { reworkComment } from '../../functions/pr-body.ts';
import { parseReportFile, type Delivery } from '../../lib/report-file.ts';
import { pullRequestOpenedMessage, reportMessage } from './messages.ts';
import { issueNumberFromUrl } from './started.ts';
import type { ReporterDeps } from './types.ts';

const SINCE_MARGIN_MS = 5 * 60_000;

/** A hidden line on every outcome comment: GitHub shows nothing of it. */
export function outcomeMarker(workItemId: string): string {
  return `<!-- factorial:outcome ${workItemId} -->`;
}

/** Another attempt holds a live claim: fail, so Lambda retries once it has confirmed or lapsed. */
export class DeliveryInProgressError extends Error {
  constructor(workItemId: string) {
    super(`another attempt is delivering the outcome of ${workItemId}`);
    this.name = 'DeliveryInProgress';
  }
}

/** The report the outcome points at is missing or malformed: a fault to look at, so the event goes to the failed queue. */
export class ReportUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportUnreadable';
  }
}

/** What to post, and where. */
export interface DeliveryPlan {
  /** The issue or pull request the comment goes on. */
  target: number;
  body: string;
  /** Whom to ask to review again: a rework after a review. */
  reviewers: string[];
}

/** Where the requester is told: the pull request the turn continued, otherwise the source issue, if any. */
export function commentTarget(outcome: Outcome): number | undefined {
  if (outcome.inReplyTo) return outcome.inReplyTo.number;
  if (outcome.source.type !== TRIGGER_TYPES.githubIssue) return undefined;
  return issueNumberFromUrl(outcome.source.url, outcome.repository);
}

function expect<K extends Delivery['kind']>(delivery: Delivery | undefined, kind: K): Extract<Delivery, { kind: K }> {
  if (delivery?.kind !== kind) throw new ReportUnreadableError(`report.json carries ${delivery ? `a ${delivery.kind}` : 'no'} delivery, not ${kind}`);
  return delivery as Extract<Delivery, { kind: K }>;
}

/** The comment for an outcome, or undefined when there is nothing to say or nowhere to say it. */
export function planDelivery(outcome: Outcome, delivery: Delivery | undefined): DeliveryPlan | undefined {
  const target = commentTarget(outcome);
  if (target === undefined) return undefined;
  switch (outcome.result) {
    case 'pr-opened':
      // Only an issue is told: a pull request that opened another would be told by its own outcome.
      if (outcome.inReplyTo || !outcome.pullRequest) return undefined;
      return { target, body: pullRequestOpenedMessage(outcome.pullRequest.url), reviewers: [] };
    case 'pr-updated': {
      const { reply, reviewers } = expect(delivery, 'rework-reply');
      return { target, body: reworkComment(reply), reviewers };
    }
    case 'refused': {
      const { reply } = expect(delivery, 'refusal');
      return reply && outcome.inReplyTo ? { target, body: reply, reviewers: [] } : undefined;
    }
    case 'no-changes':
    case 'tests-failed':
    case 'invalid-plan':
    case 'failed': {
      const { facts } = expect(delivery, 'report');
      return { target, body: reportMessage(facts, outcome.repository), reviewers: [] };
    }
  }
}

async function readDelivery(outcome: Outcome, deps: ReporterDeps): Promise<Delivery | undefined> {
  if (outcome.result === 'pr-opened') return undefined;
  const text = await deps.readReport(outcome.artefactPrefix);
  if (text === undefined) throw new ReportUnreadableError(`no report.json under ${outcome.artefactPrefix}`);
  const parsed = parseReportFile(redactSecrets(text));
  if (!parsed.ok) throw new ReportUnreadableError(parsed.error);
  return parsed.value.delivery;
}

/** Whether a comment by the App carrying the marker is already on the target, posted since the outcome was built. */
async function alreadyPosted(outcome: Outcome, target: number, client: Awaited<ReturnType<ReporterDeps['github']>>, deps: ReporterDeps): Promise<boolean> {
  const repo = { owner: outcome.repository.owner, name: outcome.repository.name };
  const bot = await deps.botLogin();
  const marker = outcomeMarker(outcome.workItemId);
  // A margin for the clocks of the Lambda that built the outcome and GitHub's.
  const since = new Date(Date.parse(outcome.at) - SINCE_MARGIN_MS).toISOString();
  const comments = await client.listIssueComments(repo, target, { since });
  return comments.some((c) => c.authorLogin === bot && c.body.includes(marker));
}

export async function deliverOutcome(outcome: Outcome, deps: ReporterDeps): Promise<void> {
  const { log } = deps;
  // Nowhere to say it: the report is not even read.
  const plan = commentTarget(outcome) === undefined ? undefined : planDelivery(outcome, await readDelivery(outcome, deps));
  if (!plan) {
    log.info('outcome needs no comment', { result: outcome.result });
    return;
  }

  const claim = await deps.deliveries.claim(outcome.workItemId, deps.now());
  if (claim.kind === 'delivered' || claim.kind === 'no-row') {
    log.info('outcome already delivered, or no ledger row', { claim: claim.kind });
    return;
  }
  if (claim.kind === 'in-progress') throw new DeliveryInProgressError(outcome.workItemId);

  const repo = { owner: outcome.repository.owner, name: outcome.repository.name };
  const onPullRequest = outcome.inReplyTo !== undefined;
  const permissions: TokenPermissions = { issues: 'write', ...(onPullRequest || plan.reviewers.length > 0 ? { pull_requests: 'write' } : {}) };
  try {
    const client = await deps.github(repo, permissions);
    const posted = claim.takeover && (await alreadyPosted(outcome, plan.target, client, deps));
    if (posted) log.info('outcome comment found from an earlier attempt', { target: plan.target });
    else await client.commentOnIssue(repo, plan.target, `${plan.body.trimEnd()}\n\n${outcomeMarker(outcome.workItemId)}\n`);
    if (plan.reviewers.length > 0) {
      try {
        await client.requestReviewers(repo, plan.target, plan.reviewers);
      } catch (error) {
        // A reviewer who has lost access, or the requester themselves, is
        // refused by GitHub; the reply already names them.
        log.error('review not re-requested', { error, reviewers: plan.reviewers });
      }
    }
  } catch (error) {
    try {
      await deps.deliveries.release(outcome.workItemId, claim.claimedAt);
    } catch (releaseError) {
      log.error('claim not released', { error: releaseError });
    }
    throw error;
  }
  await deps.deliveries.confirm(outcome.workItemId, claim.claimedAt, deps.now());
  log.info('outcome delivered', { result: outcome.result, target: plan.target, reviewers: plan.reviewers });
}
