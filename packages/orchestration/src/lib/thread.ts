/**
 * The thread ledger (#163): one row per branch Factorial works on, the unit
 * of continuity. Every turn (a new request, a resumed attempt, a rework of
 * the pull request) belongs to the thread of the branch it works on, and its
 * work item row carries the thread's key.
 *
 * The row holds pointers and counts only, never content. Admission writes
 * are conditional on the version read, so two turns cannot both claim it.
 */
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, type UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

import type { PullRequestOutcome } from '@factorial/progress';

import { requireEnv } from './env.ts';
import type { ThreadState } from './thread-policy.ts';

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export interface Thread extends ThreadState {
  /** `<owner>/<name>#<branch>`, owner and name in lower case. */
  threadKey: string;
  owner: string;
  name: string;
  branch: string;
  /** The work item whose turn created the thread. */
  openedBy: string;
  /** The `sourceKey` of the request that created the thread, so a request's threads can be listed. */
  sourceKey: string;
  /** Set once a pull request is open from the branch: `<owner>/<name>#<number>`, lower case. */
  pullRequestKey?: string;
  prNumber?: number;
  /** The work item that opened the pull request: the previous item a rework continues. */
  prOpenedBy?: string;
  /** What became of the pull request (#204): merged, or closed without merging; the latest close. */
  outcome?: PullRequestOutcome;
  /** Incremented by every admission write, which is conditional on it. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type NewThread = Omit<Thread, 'version' | 'createdAt' | 'updatedAt'>;

/** The thread key for a branch: GitHub names ignore case, branch names do not. */
export function threadKeyFor(repo: { owner: string; name: string }, branch: string): string {
  return `${`${repo.owner}/${repo.name}`.toLowerCase()}#${branch}`;
}

const tableName = (): string => requireEnv('THREADS_TABLE_NAME');

export async function getThread(threadKey: string): Promise<Thread | undefined> {
  const result = await documents.send(new GetCommand({ TableName: tableName(), Key: { threadKey }, ConsistentRead: true }));
  return result.Item as Thread | undefined;
}

/** The key of the thread that records a pull request Factorial opened, if one does. */
export async function threadKeyForPullRequest(pullRequestKey: string): Promise<string | undefined> {
  const result = await documents.send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: 'pullRequestKey-index',
      KeyConditionExpression: 'pullRequestKey = :key',
      ExpressionAttributeValues: { ':key': pullRequestKey },
      Limit: 1,
    }),
  );
  return (result.Items?.[0] as { threadKey?: string } | undefined)?.threadKey;
}

/** The thread of a pull request Factorial opened, if one records it. */
export async function threadForPullRequest(pullRequestKey: string): Promise<Thread | undefined> {
  const key = await threadKeyForPullRequest(pullRequestKey);
  return key === undefined ? undefined : getThread(key);
}

/** The newest thread a request opened, if any: where a new attempt at the request may resume. */
export async function newestThreadForSource(sourceKey: string): Promise<Thread | undefined> {
  const result = await documents.send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: 'sourceKey-createdAt-index',
      KeyConditionExpression: 'sourceKey = :key',
      ExpressionAttributeValues: { ':key': sourceKey },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const key = (result.Items?.[0] as { threadKey?: string } | undefined)?.threadKey;
  return key === undefined ? undefined : getThread(key);
}

/** Create the thread, or return it as it is when another turn created it first. */
export async function openThread(thread: NewThread): Promise<Thread> {
  const now = new Date().toISOString();
  const row: Thread = { ...thread, version: 0, createdAt: now, updatedAt: now };
  try {
    await documents.send(new PutCommand({ TableName: tableName(), Item: row, ConditionExpression: 'attribute_not_exists(threadKey)' }));
    return row;
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
    const existing = await getThread(thread.threadKey);
    if (!existing) throw error;
    return existing;
  }
}

export class ThreadChangedError extends Error {
  constructor(threadKey: string) {
    super(`thread ${threadKey} changed while a turn was being admitted`);
    this.name = 'ThreadChanged';
  }
}

/** Write the admission state, only if the thread is still at the version read. */
export async function writeThreadState(thread: Pick<Thread, 'threadKey' | 'version'>, state: Required<ThreadState>): Promise<void> {
  try {
    await documents.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { threadKey: thread.threadKey },
        UpdateExpression: 'SET inFlight = :inFlight, automaticReworks = :automatic, limitAnnounced = :announced, version = :next, updatedAt = :now',
        ConditionExpression: 'version = :version',
        ExpressionAttributeValues: {
          ':inFlight': state.inFlight,
          ':automatic': state.automaticReworks,
          ':announced': state.limitAnnounced,
          ':version': thread.version,
          ':next': thread.version + 1,
          ':now': new Date().toISOString(),
        },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) throw new ThreadChangedError(thread.threadKey);
    throw error;
  }
}

/** Record that the limit on automatic reworks has been announced, only if the thread is still at the version read. */
export async function announceLimit(thread: Pick<Thread, 'threadKey' | 'version'>): Promise<void> {
  try {
    await documents.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { threadKey: thread.threadKey },
        UpdateExpression: 'SET limitAnnounced = :true, version = :next, updatedAt = :now',
        ConditionExpression: 'version = :version',
        ExpressionAttributeValues: { ':true': true, ':version': thread.version, ':next': thread.version + 1, ':now': new Date().toISOString() },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) throw new ThreadChangedError(thread.threadKey);
    throw error;
  }
}

/** Record the pull request opened from the thread's branch, and the item that opened it. */
export async function recordThreadPullRequest(threadKey: string, pr: { pullRequestKey: string; number: number; openedBy: string }): Promise<void> {
  await documents.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { threadKey },
      UpdateExpression: 'SET pullRequestKey = :key, prNumber = :number, prOpenedBy = :by, updatedAt = :now',
      ConditionExpression: 'attribute_exists(threadKey)',
      ExpressionAttributeValues: { ':key': pr.pullRequestKey, ':number': pr.number, ':by': pr.openedBy, ':now': new Date().toISOString() },
    }),
  );
}

/** Where an outcome is recorded: the thread, the pull request it records and the branch it was opened from. */
export interface OutcomeTarget {
  threadKey: string;
  prNumber: number;
  branch: string;
}

/**
 * The write that records a pull request's outcome on its thread: only if the
 * thread records that pull request from that branch, and holds no later
 * close. A repeat of the same close sets the same values. It leaves
 * `version` alone: the outcome is not an admission.
 */
export function outcomeUpdate(table: string, target: OutcomeTarget, outcome: PullRequestOutcome): UpdateCommandInput {
  return {
    TableName: table,
    Key: { threadKey: target.threadKey },
    UpdateExpression: 'SET #outcome = :outcome, updatedAt = :now',
    ConditionExpression: 'prNumber = :number AND #branch = :branch AND (attribute_not_exists(#outcome) OR #outcome.#at <= :at)',
    ExpressionAttributeNames: { '#outcome': 'outcome', '#branch': 'branch', '#at': 'at' },
    ExpressionAttributeValues: { ':outcome': outcome, ':number': target.prNumber, ':branch': target.branch, ':at': outcome.at, ':now': new Date().toISOString() },
    ReturnValues: 'ALL_NEW',
    ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
  };
}

/** Whether the outcome was recorded, and the thread after the write, or as it was when the condition failed. */
export interface OutcomeResult {
  recorded: boolean;
  thread?: Partial<Thread>;
}

export async function recordThreadOutcome(target: OutcomeTarget, outcome: PullRequestOutcome): Promise<OutcomeResult> {
  try {
    const result = await documents.send(new UpdateCommand(outcomeUpdate(tableName(), target, outcome)));
    return { recorded: true, thread: result.Attributes as Partial<Thread> };
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
    // lib-dynamodb does not unmarshall the item an exception carries.
    const item = (error as { Item?: Parameters<typeof unmarshall>[0] }).Item;
    return { recorded: false, ...(item ? { thread: unmarshall(item) as Partial<Thread> } : {}) };
  }
}
