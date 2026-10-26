/** The work item ledger: one row per WorkItem, also the idempotency guard. */
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { artefactPrefix } from '@factorial/artefacts';
import type { WorkItem } from '@factorial/workitem';

import { requireEnv } from './env.ts';
import { lineageAttributes } from './lineage.ts';
import { sourceKey, type Attempt } from './resume.ts';
import type { EarlierItem } from './rework-admission.ts';

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export class DuplicateWorkItemError extends Error {
  constructor(id: string) {
    super(`WorkItem ${id} has already been accepted`);
    this.name = 'DuplicateWorkItem';
  }
}

/** Record a new WorkItem exactly once, with its attempt number, artefact prefix and any lineage. Returns the row's `createdAt`. */
export async function acceptWorkItem(workItem: WorkItem, factorialVersion: string, attempt: number): Promise<string> {
  const now = new Date().toISOString();
  try {
    await documents.send(
      new PutCommand({
        TableName: requireEnv('TABLE_NAME'),
        Item: {
          workItemId: workItem.id,
          workItem,
          sourceKey: sourceKey(workItem),
          status: 'accepted',
          factorialVersion,
          attempt,
          artefactPrefix: artefactPrefix(workItem.id, attempt),
          ...lineageAttributes(workItem),
          createdAt: now,
          updatedAt: now,
        },
        ConditionExpression: 'attribute_not_exists(workItemId)',
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      throw new DuplicateWorkItemError(workItem.id);
    }
    throw error;
  }
  return now;
}

/** Earlier attempts at the same source as this WorkItem, newest first. */
export async function attemptsAtSource(workItem: WorkItem): Promise<Attempt[]> {
  const result = await documents.send(
    new QueryCommand({
      TableName: requireEnv('TABLE_NAME'),
      IndexName: 'sourceKey-createdAt-index',
      KeyConditionExpression: 'sourceKey = :key',
      ExpressionAttributeValues: { ':key': sourceKey(workItem) },
      ScanIndexForward: false,
      Limit: 10,
    }),
  );
  return (result.Items ?? []) as Attempt[];
}

/** More items than any pull request should ever gather; past it, admission refuses rather than judge on part of the record. */
export const MAX_ITEMS_AT_SOURCE = 1_000;

export class TooManyItemsError extends Error {
  constructor(key: string) {
    super(`more than ${MAX_ITEMS_AT_SOURCE} items at ${key}`);
    this.name = 'TooManyItems';
  }
}

/**
 * Every item at the same source, newest first, with when each was accepted:
 * for a pull request source, every rework item for that pull request. All
 * pages are read, so refused items cannot push a running item or an earlier
 * attempt out of view.
 */
export async function itemsAtSource(workItem: WorkItem): Promise<EarlierItem[]> {
  const key = sourceKey(workItem);
  const items: EarlierItem[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await documents.send(
      new QueryCommand({
        TableName: requireEnv('TABLE_NAME'),
        IndexName: 'sourceKey-createdAt-index',
        KeyConditionExpression: 'sourceKey = :key',
        ExpressionAttributeValues: { ':key': key },
        ProjectionExpression: 'workItemId, #status, createdAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ScanIndexForward: false,
        ...(start ? { ExclusiveStartKey: start } : {}),
      }),
    );
    items.push(...((page.Items ?? []) as EarlierItem[]));
    if (items.length > MAX_ITEMS_AT_SOURCE) throw new TooManyItemsError(key);
    start = page.LastEvaluatedKey;
  } while (start);
  return items;
}

/** The rework cause recorded in an item's WorkItem, if it has one. Not in the source index, so read from the row. */
export async function reworkCauseOf(workItemId: string): Promise<string | undefined> {
  const result = await documents.send(
    new GetCommand({
      TableName: requireEnv('TABLE_NAME'),
      Key: { workItemId },
      ProjectionExpression: '#w.#c.#k',
      ExpressionAttributeNames: { '#w': 'workItem', '#c': 'context', '#k': 'cause' },
    }),
  );
  const cause = (result.Item as { workItem?: { context?: { cause?: unknown } } } | undefined)?.workItem?.context?.cause;
  return typeof cause === 'string' ? cause : undefined;
}

/** The ledger's key for a pull request, `<owner>/<name>#<number>` in lower case: GitHub names ignore case. */
export function pullRequestKey(repo: { owner: string; name: string }, number: number): string {
  return `${repo.owner}/${repo.name}#${number}`.toLowerCase();
}

/** The item that opened a pull request, and its branch, if Factorial opened it. */
export async function openerOf(repo: { owner: string; name: string }, number: number): Promise<{ workItemId: string; branch?: string } | undefined> {
  const result = await documents.send(
    new QueryCommand({
      TableName: requireEnv('TABLE_NAME'),
      IndexName: 'pullRequestKey-index',
      KeyConditionExpression: 'pullRequestKey = :key',
      ExpressionAttributeValues: { ':key': pullRequestKey(repo, number) },
      Limit: 1,
    }),
  );
  return result.Items?.[0] as { workItemId: string; branch?: string } | undefined;
}

/** The attempt number and artefact prefix on a ledger row, if the row exists. */
export async function attemptRecord(workItemId: string): Promise<{ attempt?: number; artefactPrefix?: string } | undefined> {
  const result = await documents.send(
    new GetCommand({
      TableName: requireEnv('TABLE_NAME'),
      Key: { workItemId },
      ProjectionExpression: '#attempt, #prefix',
      ExpressionAttributeNames: { '#attempt': 'attempt', '#prefix': 'artefactPrefix' },
    }),
  );
  return result.Item as { attempt?: number; artefactPrefix?: string } | undefined;
}

/** Merge progress into the row. Keys are attribute names; values replace. */
export async function recordProgress(workItemId: string, status: string, attributes: Record<string, unknown> = {}): Promise<void> {
  const fields: Record<string, unknown> = { ...attributes, status, updatedAt: new Date().toISOString() };
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  let i = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    i += 1;
    names[`#k${i}`] = key;
    values[`:v${i}`] = value;
    sets.push(`#k${i} = :v${i}`);
  }
  await documents.send(
    new UpdateCommand({
      TableName: requireEnv('TABLE_NAME'),
      Key: { workItemId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}
