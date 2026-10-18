/**
 * Ledger access for the PR rework trigger: look up the WorkItems already
 * raised against a pull request, by PR number, and count the automatic
 * checks-failed reworks that have not been interrupted by a human comment.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { MAX_AUTOMATIC_CHECKS_REWORKS, type PrEventDecision } from './pr-event.ts';

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** A ledger row, trimmed to what the trigger needs. */
export interface LedgerRow {
  workItemId: string;
  /** 'checks-failed' or 'review' for rework items; other statuses exist for originals. */
  cause?: 'review' | 'checks-failed';
  requestedBy?: string;
  createdAt?: string;
}

/**
 * The WorkItems recorded against one pull request, newest first. Reads the
 * `prNumber-index` GSI on the factorial-work-items ledger, which open-pr and
 * acceptWorkItem keep populated with every PR's items.
 */
export async function listPrWorkItems(prNumber: number): Promise<LedgerRow[]> {
  const result = await documents.send(
    new QueryCommand({
      TableName: process.env.TABLE_NAME,
      IndexName: 'prNumber-index',
      KeyConditionExpression: 'prNumber = :n',
      ExpressionAttributeValues: { ':n': prNumber },
      ScanIndexForward: false,
    }),
  );
  return (result.Items ?? []).map((item) => ({
    workItemId: item.workItemId as string,
    ...(item.cause === undefined ? {} : { cause: item.cause as 'review' | 'checks-failed' }),
    ...(item.requestedBy === undefined ? {} : { requestedBy: item.requestedBy as string }),
    ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt as string }),
  }));
}

/**
 * How many automatic checks-failed reworks have run for this PR with no human
 * comment (a review-triggered item) in between: walk the items newest first
 * and count the leading run of checks-failed items.
 */
export function automaticChecksReworks(rows: readonly LedgerRow[]): number {
  let count = 0;
  for (const row of rows) {
    if (row.cause === 'checks-failed') {
      count += 1;
    } else {
      break;
    }
  }
  return count;
}

/** May another automatic checks-failed rework start for this PR? */
export function mayStartAutomaticChecksRework(rows: readonly LedgerRow[]): boolean {
  return automaticChecksReworks(rows) < MAX_AUTOMATIC_CHECKS_REWORKS;
}

/** The id of the WorkItem whose PR is being reworked: the newest item for the PR. */
export function previousWorkItemFor(rows: readonly LedgerRow[]): string | undefined {
  return rows[0]?.workItemId;
}

/**
 * Resolve the checks-failed decision against the ledger. No WorkItem for the
 * PR, or the cap already reached, means ignore.
 */
export function resolveChecksFailed(
  decision: Extract<PrEventDecision, { kind: 'rework-checks-failed' }>,
  rows: readonly LedgerRow[],
): { kind: 'ignore'; reason: string } | { kind: 'ok'; previousWorkItemId: string } {
  const previousWorkItemId = previousWorkItemFor(rows);
  if (previousWorkItemId === undefined) {
    return { kind: 'ignore', reason: 'no WorkItem recorded for this pull request' };
  }
  if (!mayStartAutomaticChecksRework(rows)) {
    return {
      kind: 'ignore',
      reason: `already ${automaticChecksReworks(rows)} automatic checks-failed reworks without a human comment`,
    };
  }
  return { kind: 'ok', previousWorkItemId };
}
