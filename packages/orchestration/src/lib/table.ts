/** The work item ledger: one row per WorkItem, also the idempotency guard. */
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import type { WorkItem } from '@factorial/workitem';

import { requireEnv } from './env.ts';
import { sourceKey, type Attempt } from './resume.ts';

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export class DuplicateWorkItemError extends Error {
  constructor(id: string) {
    super(`WorkItem ${id} has already been accepted`);
    this.name = 'DuplicateWorkItem';
  }
}

/** Record a new WorkItem exactly once. */
export async function acceptWorkItem(workItem: WorkItem, factorialVersion: string): Promise<void> {
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
