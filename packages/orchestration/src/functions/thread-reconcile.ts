/**
 * Thread reconcile (#237): hourly, record the pull request closes GitHub
 * never sent (lib/thread-reconcile.ts). Reached by the schedule rule
 * `factorial-thread-reconcile`.
 */
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

import type { GitHubClient, Repo } from '@factorial/github-app';
import { createLogger } from '@factorial/log';
import { progressRecorder } from '@factorial/progress';

import { repositoryClient } from '../lib/github.ts';
import { progressRow } from '../lib/table.ts';
import { recordThreadOutcome, threadKeyForPullRequest, threadsAwaitingOutcome } from '../lib/thread.ts';
import { recordPullRequestClosed } from '../lib/thread-outcome.ts';
import { METRIC_NAMESPACE, missedCloseMetrics, reconcileThreads } from '../lib/thread-reconcile.ts';

const cloudWatch = new CloudWatchClient({});

export async function handler(): Promise<void> {
  const log = createLogger('thread-reconcile');
  const progress = progressRecorder(process.env, { onError: (message, fields) => log.error(message, fields) });
  // One read-only token per repository for the run.
  const clients = new Map<string, Promise<GitHubClient>>();
  const client = (repo: Repo): Promise<GitHubClient> => {
    const key = `${repo.owner}/${repo.name}`.toLowerCase();
    let found = clients.get(key);
    if (!found) {
      found = repositoryClient(repo, { pull_requests: 'read' });
      // A failed mint is not cached: the next thread tries again.
      found.catch(() => clients.delete(key));
      clients.set(key, found);
    }
    return found;
  };
  try {
    await reconcileThreads({
      threadsAwaitingOutcome,
      pullRequest: async (repo, number) => (await client(repo)).getPullRequestClose(repo, number),
      closedBy: async (repo, number) => (await client(repo)).closedBy(repo, number),
      record: (closed) =>
        recordPullRequestClosed(closed, {
          threadKeyFor: threadKeyForPullRequest,
          recordOutcome: (target, outcome) => recordThreadOutcome(target, outcome, { first: true }),
          ledgerRow: progressRow,
          announce: (row, prNumber, outcome) => progress.pullRequestClosed(row, prNumber, outcome),
          log,
        }),
      countMissed: async (missed) => {
        await cloudWatch.send(new PutMetricDataCommand({ Namespace: METRIC_NAMESPACE, MetricData: missedCloseMetrics(missed) }));
      },
      log,
      now: () => new Date(),
    });
  } catch (error) {
    log.error('failed', { error });
    throw error;
  }
}
