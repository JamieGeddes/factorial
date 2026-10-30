/**
 * The notifier's idempotency guard: `startedNotifiedAt` on the ledger row,
 * written with a condition before the "started" comment is posted, so a
 * work item gets at most one comment however often its event is delivered.
 */
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, type UpdateCommandInput } from '@aws-sdk/lib-dynamodb';

import { requireEnv } from './env.ts';

export interface NotifyLedger {
  /** Record that the started notice is being sent. False when it was already recorded, or the item has no row. */
  claimStarted(workItemId: string, at: string): Promise<boolean>;
  /** Undo a claim whose notice failed, so a retry can send it. Only the claim made at `at` is undone. */
  releaseStarted(workItemId: string, at: string): Promise<void>;
}

/** The write that claims the notice: it needs the row, and no earlier claim. */
export function claimStartedInput(tableName: string, workItemId: string, at: string): UpdateCommandInput {
  return {
    TableName: tableName,
    Key: { workItemId },
    UpdateExpression: 'SET startedNotifiedAt = :at',
    ConditionExpression: 'attribute_exists(workItemId) AND attribute_not_exists(startedNotifiedAt)',
    ExpressionAttributeValues: { ':at': at },
  };
}

/** The write that undoes a claim, if it is still the one made at `at`. */
export function releaseStartedInput(tableName: string, workItemId: string, at: string): UpdateCommandInput {
  return {
    TableName: tableName,
    Key: { workItemId },
    UpdateExpression: 'REMOVE startedNotifiedAt',
    ConditionExpression: 'startedNotifiedAt = :at',
    ExpressionAttributeValues: { ':at': at },
  };
}

export class DynamoNotifyLedger implements NotifyLedger {
  readonly #documents = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

  async claimStarted(workItemId: string, at: string): Promise<boolean> {
    try {
      await this.#documents.send(new UpdateCommand(claimStartedInput(requireEnv('TABLE_NAME'), workItemId, at)));
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return false;
      throw error;
    }
  }

  async releaseStarted(workItemId: string, at: string): Promise<void> {
    try {
      await this.#documents.send(new UpdateCommand(releaseStartedInput(requireEnv('TABLE_NAME'), workItemId, at)));
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return;
      throw error;
    }
  }
}

/** A ledger in memory, for tests. `rows` are the work items that have a row. */
export class MemoryNotifyLedger implements NotifyLedger {
  readonly claimed = new Map<string, string>();
  readonly #rows: Set<string> | undefined;

  /** With no `rows`, every work item has a row. */
  constructor(rows?: Iterable<string>) {
    this.#rows = rows ? new Set(rows) : undefined;
  }

  async claimStarted(workItemId: string, at: string): Promise<boolean> {
    if (this.#rows && !this.#rows.has(workItemId)) return false;
    if (this.claimed.has(workItemId)) return false;
    this.claimed.set(workItemId, at);
    return true;
  }

  async releaseStarted(workItemId: string, at: string): Promise<void> {
    if (this.claimed.get(workItemId) === at) this.claimed.delete(workItemId);
  }
}
