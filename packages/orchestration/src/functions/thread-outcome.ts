/**
 * Thread outcome: record what became of a pull request Factorial opened on
 * its thread (lib/thread-outcome.ts). Reached by the rule that routes
 * PullRequestClosed events to it.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

import { createLogger } from '@factorial/log';
import { progressRecorder, type LedgerRow } from '@factorial/progress';

import { requireEnv } from '../lib/env.ts';
import { recordThreadOutcome, threadKeyForPullRequest } from '../lib/thread.ts';
import { recordPullRequestClosed } from '../lib/thread-outcome.ts';

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** The parts of the ledger row a progress event is built from: never the work item's text. */
async function ledgerRow(workItemId: string): Promise<LedgerRow | undefined> {
  const result = await documents.send(
    new GetCommand({
      TableName: requireEnv('TABLE_NAME'),
      Key: { workItemId },
      ProjectionExpression: '#id, #item.#source, #item.#repository, #attempt, #thread',
      ExpressionAttributeNames: {
        '#id': 'workItemId',
        '#item': 'workItem',
        '#source': 'source',
        '#repository': 'repository',
        '#attempt': 'attempt',
        '#thread': 'threadKey',
      },
    }),
  );
  return result.Item as LedgerRow | undefined;
}

/** An EventBridge event whose `detail` is the PullRequestClosed. */
export async function handler(event: { detail?: unknown }): Promise<void> {
  const log = createLogger('thread-outcome');
  // Best effort: a failed announcement is logged; the thread already records the outcome.
  const progress = progressRecorder(process.env, { onError: (message, fields) => log.error(message, fields) });
  try {
    await recordPullRequestClosed(event.detail, {
      threadKeyFor: threadKeyForPullRequest,
      recordOutcome: recordThreadOutcome,
      ledgerRow,
      announce: (row, prNumber, outcome) => progress.pullRequestClosed(row, prNumber, outcome),
      log,
    });
  } catch (error) {
    log.error('failed', { error });
    throw error;
  }
}
