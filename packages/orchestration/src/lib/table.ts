/** The work item ledger: one row per WorkItem, also the idempotency guard. */
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { artefactPrefix } from '@factorial/artefacts';
import type { WorkItem } from '@factorial/workitem';

import { requireEnv } from './env.ts';
import { lineageAttributes } from './lineage.ts';
import { sourceKey } from './resume.ts';

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export class DuplicateWorkItemError extends Error {
  constructor(id: string) {
    super(`WorkItem ${id} has already been accepted`);
    this.name = 'DuplicateWorkItem';
  }
}

/**
 * Record a new WorkItem exactly once, with its attempt number, artefact
 * prefix, the execution running it and any lineage. Returns the row's
 * `createdAt`.
 */
export async function acceptWorkItem(workItem: WorkItem, factorialVersion: string, attempt: number, executionArn?: string): Promise<string> {
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
          executionArn,
          // Each stage's record (@factorial/progress); Intake's is the first.
          stages: {},
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

/** The key for a pull request on its thread, `<owner>/<name>#<number>` in lower case: GitHub names ignore case. */
export function pullRequestKey(repo: { owner: string; name: string }, number: number): string {
  return `${repo.owner}/${repo.name}#${number}`.toLowerCase();
}

/** The ledger status of an item, if it has a row. */
export async function statusOf(workItemId: string): Promise<string | undefined> {
  const result = await documents.send(
    new GetCommand({
      TableName: requireEnv('TABLE_NAME'),
      Key: { workItemId },
      ProjectionExpression: '#status',
      ExpressionAttributeNames: { '#status': 'status' },
    }),
  );
  const status = (result.Item as { status?: unknown } | undefined)?.status;
  return typeof status === 'string' ? status : undefined;
}

/** What a ledger row says of its attempt: Intake writes the route, thread and branch, later stages the rest. */
export interface AttemptRecord {
  attempt?: number;
  artefactPrefix?: string;
  savedWork?: boolean;
  route?: string;
  threadKey?: string;
  branch?: string;
}

/** The attempt number, artefact prefix, whether work was saved, and Intake's route and thread, on a ledger row, if the row exists. */
export async function attemptRecord(workItemId: string): Promise<AttemptRecord | undefined> {
  const result = await documents.send(
    new GetCommand({
      TableName: requireEnv('TABLE_NAME'),
      Key: { workItemId },
      ProjectionExpression: '#attempt, #prefix, savedWork, #route, threadKey, branch',
      ExpressionAttributeNames: { '#attempt': 'attempt', '#prefix': 'artefactPrefix', '#route': 'route' },
    }),
  );
  return result.Item as AttemptRecord | undefined;
}

/** One turn on a thread, as the thread index projects it. */
export interface Turn {
  workItemId: string;
  status?: string;
  sourceKey?: string;
  createdAt?: string;
}

/** A thread's turns, newest first: the most any thread should gather is far below one page. */
export async function turnsOf(threadKey: string): Promise<Turn[]> {
  const result = await documents.send(
    new QueryCommand({
      TableName: requireEnv('TABLE_NAME'),
      IndexName: 'threadKey-createdAt-index',
      KeyConditionExpression: 'threadKey = :key',
      ExpressionAttributeValues: { ':key': threadKey },
      ScanIndexForward: false,
      Limit: 100,
    }),
  );
  return (result.Items ?? []) as Turn[];
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
