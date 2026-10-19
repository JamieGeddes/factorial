/** The work item ledger: one row per WorkItem, also the idempotency guard. */
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { artefactPrefix } from '@factorial/artefacts';
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

/** Record a new WorkItem exactly once, with its attempt number and artefact prefix. */
export async function acceptWorkItem(workItem: WorkItem, factorialVersion: string, attempt: number): Promise<void> {
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
