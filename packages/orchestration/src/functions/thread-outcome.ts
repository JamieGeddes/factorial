/**
 * Thread outcome: record what became of a pull request Factorial opened on
 * its thread (lib/thread-outcome.ts). Reached by the rule that routes
 * PullRequestClosed events to it.
 */
import { createLogger } from '@factorial/log';
import { progressRecorder } from '@factorial/progress';

import { progressRow } from '../lib/table.ts';
import { recordThreadOutcome, threadKeyForPullRequest } from '../lib/thread.ts';
import { recordPullRequestClosed } from '../lib/thread-outcome.ts';

/** An EventBridge event whose `detail` is the PullRequestClosed. */
export async function handler(event: { detail?: unknown }): Promise<void> {
  const log = createLogger('thread-outcome');
  // Best effort: a failed announcement is logged; the thread already records the outcome.
  const progress = progressRecorder(process.env, { onError: (message, fields) => log.error(message, fields) });
  try {
    await recordPullRequestClosed(event.detail, {
      threadKeyFor: threadKeyForPullRequest,
      recordOutcome: recordThreadOutcome,
      ledgerRow: progressRow,
      announce: (row, prNumber, outcome) => progress.pullRequestClosed(row, prNumber, outcome),
      log,
    });
  } catch (error) {
    log.error('failed', { error });
    throw error;
  }
}
