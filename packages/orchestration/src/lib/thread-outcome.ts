/**
 * What became of a pull request Factorial opened (#204): a PullRequestClosed
 * event (`contracts/pull-request-closed/v1/`) from a trigger adapter is
 * recorded on the pull request's thread as `outcome`, then announced as a
 * WorkItemProgress event for the item that opened the pull request.
 *
 * The thread is the record: a pull request no thread records, or one whose
 * thread holds a later close, changes nothing and is logged. A repeat of the
 * same close sets the same values and announces the same event again.
 */
import type { LedgerRow, PullRequestOutcome } from '@factorial/progress';
import { validatePullRequestClosed, type PullRequestClosed } from '@factorial/pull-request-closed';

import type { Logger } from './log.ts';
import { pullRequestKey as keyFor } from './table.ts';
import type { OutcomeResult, OutcomeTarget } from './thread.ts';

/** What recording an outcome needs from the world, so tests can stand in for it. */
export interface ThreadOutcomeDeps {
  /** The key of the thread that records the pull request, `<owner>/<name>#<number>` in lower case. */
  threadKeyFor(pullRequestKey: string): Promise<string | undefined>;
  recordOutcome(target: OutcomeTarget, outcome: PullRequestOutcome): Promise<OutcomeResult>;
  /** The ledger row of the item that opened the pull request: the parts an event is built from. */
  ledgerRow(workItemId: string): Promise<LedgerRow | undefined>;
  announce(row: LedgerRow, prNumber: number, outcome: PullRequestOutcome): Promise<void>;
  log: Logger;
}

/** The outcome a close records on the thread. */
export function outcomeOf(closed: PullRequestClosed): PullRequestOutcome {
  return {
    state: closed.merged ? 'merged' : 'closed',
    at: closed.closedAt,
    by: closed.by,
    ...(closed.merged && closed.mergeCommit ? { mergeCommit: closed.mergeCommit } : {}),
  };
}

/** Why a close was not recorded, from the thread as the failed condition found it. */
function notRecordedReason(target: OutcomeTarget, thread: OutcomeResult['thread']): string {
  if (!thread) return 'the thread no longer exists';
  if (thread.prNumber !== target.prNumber) return `the thread records pull request #${String(thread.prNumber)}`;
  if (thread.branch !== target.branch) return `the thread is for branch ${String(thread.branch)}`;
  return `the thread records a later close, at ${String(thread.outcome?.at)}`;
}

/** Record one PullRequestClosed event. Throws only for a failure worth retrying. */
export async function recordPullRequestClosed(detail: unknown, deps: ThreadOutcomeDeps): Promise<void> {
  const parsed = validatePullRequestClosed(detail);
  if (!parsed.ok) {
    deps.log.error('event invalid; ignored', { errors: parsed.errors.slice(0, 5) });
    return;
  }
  const closed = parsed.value;
  const pullRequestKey = keyFor(closed.repository, closed.number);
  const fields = { pullRequest: pullRequestKey, merged: closed.merged };
  const threadKey = await deps.threadKeyFor(pullRequestKey);
  if (!threadKey) {
    deps.log.info('ignored: no thread records the pull request', fields);
    return;
  }
  const target = { threadKey, prNumber: closed.number, branch: closed.headBranch };
  const outcome = outcomeOf(closed);
  const result = await deps.recordOutcome(target, outcome);
  const log = typeof result.thread?.prOpenedBy === 'string' ? deps.log.with({ workItemId: result.thread.prOpenedBy }) : deps.log;
  if (!result.recorded) {
    log.info('ignored: outcome not recorded', { ...fields, threadKey, reason: notRecordedReason(target, result.thread) });
    return;
  }
  log.info('outcome recorded', { ...fields, threadKey, state: outcome.state });
  const openedBy = result.thread?.prOpenedBy;
  if (typeof openedBy !== 'string') {
    log.error('outcome not announced: the thread names no item that opened the pull request', { threadKey });
    return;
  }
  const row = await deps.ledgerRow(openedBy);
  if (!row) {
    log.error('outcome not announced: no ledger row for the item that opened the pull request', { threadKey });
    return;
  }
  await deps.announce(row, closed.number, outcome);
}
