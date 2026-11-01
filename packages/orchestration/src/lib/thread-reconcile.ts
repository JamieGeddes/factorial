/**
 * The thread reconciler (#237). A pull request's close reaches its thread
 * only if GitHub sends the webhook: an App not subscribed to the Pull request
 * event, a failed delivery or an adapter that drops the event all leave a
 * thread that never gets its outcome, and nothing errs.
 *
 * Hourly, every thread that records a pull request and no outcome has its
 * pull request read from GitHub. A close is recorded through the webhook's
 * own path (`recordPullRequestClosed`), so the thread write and the progress
 * announcement are the same, but only where the thread still holds no
 * outcome; each one recorded is a close the webhook path missed, and is
 * counted. Read-only on GitHub; it touches only threads, which only
 * Factorial's own pull requests have.
 */
import type { PullRequestClose, Repo } from '@factorial/github-app';
import { PULL_REQUEST_CLOSED_SCHEMA_VERSION, type PullRequestClosed } from '@factorial/pull-request-closed';

import type { Logger } from './log.ts';
import { pullRequestKey } from './table.ts';
import type { ThreadAwaitingOutcome } from './thread.ts';

/**
 * A close younger than this is left to the webhook path: EventBridge retries
 * `factorial-thread-outcome` for up to an hour (`MaximumEventAgeInSeconds`).
 */
export const WEBHOOK_GRACE_MS = 60 * 60 * 1000;

/** `by` when GitHub names nobody: the account was deleted. GitHub shows such accounts as `ghost`. */
export const UNKNOWN_ACTOR = 'ghost';

/** The custom metric every missed close counts towards, and its namespace. */
export const METRIC_NAMESPACE = 'Factorial';
export const MISSED_CLOSES_METRIC = 'MissedPullRequestCloses';

/** What reconciling needs from the world, so tests can stand in for it. */
export interface ReconcileDeps {
  threadsAwaitingOutcome(): Promise<ThreadAwaitingOutcome[]>;
  pullRequest(repo: Repo, number: number): Promise<PullRequestClose>;
  /** Who closed a pull request without merging it. */
  closedBy(repo: Repo, number: number): Promise<string | undefined>;
  /** Record a close through the webhook's path, only where the thread holds no outcome. Resolves whether it was recorded. */
  record(closed: PullRequestClosed): Promise<boolean>;
  /** Count missed closes, by repository (`<owner>/<name>`). */
  countMissed(missed: ReadonlyMap<string, number>): Promise<void>;
  log: Logger;
  now(): Date;
}

/** What one run did with the threads it found. */
export interface ReconcileSummary {
  threads: number;
  /** Pull requests still open. */
  open: number;
  /** Closed within the grace period: left to the webhook path. */
  recent: number;
  /** Closes the webhook path missed, now recorded. */
  recorded: number;
  /** Already recorded, or not recordable (the thread changed, or the close does not fit the contract). */
  skipped: number;
  /** Not reconciled: GitHub answered 404 or another error, or the write failed. */
  failed: number;
}

/** The PullRequestClosed event GitHub would have sent for a close. */
export function closedEvent(repo: Repo, close: PullRequestClose, by: string): PullRequestClosed {
  return {
    schemaVersion: PULL_REQUEST_CLOSED_SCHEMA_VERSION,
    repository: { provider: 'github', owner: repo.owner, name: repo.name },
    number: close.number,
    url: close.htmlUrl,
    headBranch: close.headRef,
    merged: close.merged,
    closedAt: close.closedAt ?? '',
    ...(close.merged && close.mergedAt ? { mergedAt: close.mergedAt } : {}),
    ...(close.merged && close.mergeCommit ? { mergeCommit: close.mergeCommit } : {}),
    by,
  };
}

/** The datapoints for a run's missed closes: one per repository, and one in all, which the alarm watches. */
export function missedCloseMetrics(missed: ReadonlyMap<string, number>): Array<{ MetricName: string; Dimensions?: Array<{ Name: string; Value: string }>; Value: number; Unit: 'Count' }> {
  const total = [...missed.values()].reduce((sum, n) => sum + n, 0);
  if (total === 0) return [];
  return [
    ...[...missed].map(([repository, count]) => ({ MetricName: MISSED_CLOSES_METRIC, Dimensions: [{ Name: 'Repository', Value: repository }], Value: count, Unit: 'Count' as const })),
    { MetricName: MISSED_CLOSES_METRIC, Value: total, Unit: 'Count' as const },
  ];
}

const errorStatus = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};

/** Reconcile every thread awaiting an outcome. A thread that fails is logged and the rest go on; only counting the missed closes can throw. */
export async function reconcileThreads(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const threads = await deps.threadsAwaitingOutcome();
  const summary: ReconcileSummary = { threads: threads.length, open: 0, recent: 0, recorded: 0, skipped: 0, failed: 0 };
  const missed = new Map<string, number>();
  const now = deps.now().getTime();

  for (const thread of threads) {
    const repo = { owner: thread.owner, name: thread.name };
    const key = pullRequestKey(repo, thread.prNumber);
    const log = typeof thread.prOpenedBy === 'string' ? deps.log.with({ workItemId: thread.prOpenedBy }) : deps.log;
    const fields = { threadKey: thread.threadKey, pullRequest: key };
    if (thread.outcome) {
      summary.skipped += 1;
      log.info('skipped: outcome already recorded', fields);
      continue;
    }
    try {
      const close = await deps.pullRequest(repo, thread.prNumber);
      if (close.state !== 'closed' || !close.closedAt) {
        summary.open += 1;
        continue;
      }
      if (now - Date.parse(close.closedAt) < WEBHOOK_GRACE_MS) {
        summary.recent += 1;
        log.info('left to the webhook: closed within the hour', { ...fields, closedAt: close.closedAt });
        continue;
      }
      const by = (close.merged ? close.mergedBy : await deps.closedBy(repo, thread.prNumber)) ?? UNKNOWN_ACTOR;
      if (!(await deps.record(closedEvent(repo, close, by)))) {
        summary.skipped += 1;
        continue;
      }
      summary.recorded += 1;
      const repository = `${repo.owner}/${repo.name}`;
      missed.set(repository, (missed.get(repository) ?? 0) + 1);
      log.info('missed close recorded', { ...fields, state: close.merged ? 'merged' : 'closed', closedAt: close.closedAt, by });
    } catch (error) {
      summary.failed += 1;
      log.error('not reconciled; the next run tries again', { ...fields, status: errorStatus(error), error });
    }
  }

  deps.log.info('reconciled', { ...summary });
  if (missed.size > 0) await deps.countMissed(missed);
  return summary;
}
