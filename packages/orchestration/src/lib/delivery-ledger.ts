/**
 * The reporter's guard on delivering an outcome (#165): `outcomeDelivery` on
 * the work item's ledger row, so a redelivered or retried event posts
 * nothing twice.
 *
 * - Before posting, the reporter claims the delivery with a conditional
 *   write: the row exists, and the delivery is neither confirmed nor held by
 *   a live claim.
 * - After posting, it confirms the claim it made.
 * - A failed attempt releases its claim, so the retry may take over at once.
 *   A claim older than the lease (its holder timed out) can be taken over
 *   too. Whoever takes over checks the target for the comment's marker
 *   before posting, since the earlier attempt may have posted and failed
 *   only to confirm.
 * - A live claim held by another attempt makes this one fail, so Lambda
 *   retries it once that claim has been confirmed or has lapsed.
 */
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, type UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

import { requireEnv } from './env.ts';

/** Longer than the reporter's timeout, so a claim is never taken from a running attempt. */
export const DELIVERY_LEASE_MS = 120_000;

export interface DeliveryRecord {
  claimedAt: string;
  deliveredAt?: string;
  released?: boolean;
}

export type Claim =
  /** This attempt holds the delivery; `takeover` when an earlier attempt held it first. */
  | { kind: 'claimed'; claimedAt: string; takeover: boolean }
  | { kind: 'delivered' }
  | { kind: 'in-progress'; claimedAt: string }
  /** No ledger row: nothing to deliver for. */
  | { kind: 'no-row' };

export interface DeliveryLedger {
  claim(workItemId: string, now: Date): Promise<Claim>;
  confirm(workItemId: string, claimedAt: string, now: Date): Promise<void>;
  release(workItemId: string, claimedAt: string): Promise<void>;
}

export function claimInput(tableName: string, workItemId: string, now: Date): UpdateCommandInput {
  return {
    TableName: tableName,
    Key: { workItemId },
    UpdateExpression: 'SET #delivery = :claim',
    ConditionExpression:
      'attribute_exists(workItemId) AND (attribute_not_exists(#delivery) OR (attribute_not_exists(#delivery.deliveredAt) AND (#delivery.released = :true OR #delivery.claimedAt < :stale)))',
    ExpressionAttributeNames: { '#delivery': 'outcomeDelivery' },
    ExpressionAttributeValues: {
      ':claim': { claimedAt: now.toISOString() },
      ':true': true,
      ':stale': new Date(now.getTime() - DELIVERY_LEASE_MS).toISOString(),
    },
    ReturnValues: 'UPDATED_OLD',
    ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
  };
}

export function confirmInput(tableName: string, workItemId: string, claimedAt: string, now: Date): UpdateCommandInput {
  return {
    TableName: tableName,
    Key: { workItemId },
    UpdateExpression: 'SET #delivery.deliveredAt = :now',
    ConditionExpression: '#delivery.claimedAt = :at',
    ExpressionAttributeNames: { '#delivery': 'outcomeDelivery' },
    ExpressionAttributeValues: { ':now': now.toISOString(), ':at': claimedAt },
  };
}

export function releaseInput(tableName: string, workItemId: string, claimedAt: string): UpdateCommandInput {
  return {
    TableName: tableName,
    Key: { workItemId },
    UpdateExpression: 'SET #delivery.released = :true',
    ConditionExpression: '#delivery.claimedAt = :at AND attribute_not_exists(#delivery.deliveredAt)',
    ExpressionAttributeNames: { '#delivery': 'outcomeDelivery' },
    ExpressionAttributeValues: { ':true': true, ':at': claimedAt },
  };
}

/** What a failed claim means, from the row as it was. */
export function refusedClaim(row: { outcomeDelivery?: DeliveryRecord } | undefined): Claim {
  if (!row) return { kind: 'no-row' };
  const delivery = row.outcomeDelivery;
  if (delivery?.deliveredAt) return { kind: 'delivered' };
  return { kind: 'in-progress', claimedAt: delivery?.claimedAt ?? '' };
}

export class DynamoDeliveryLedger implements DeliveryLedger {
  readonly #documents = DynamoDBDocumentClient.from(new DynamoDBClient({}));

  async claim(workItemId: string, now: Date): Promise<Claim> {
    try {
      const result = await this.#documents.send(new UpdateCommand(claimInput(requireEnv('TABLE_NAME'), workItemId, now)));
      return { kind: 'claimed', claimedAt: now.toISOString(), takeover: result.Attributes?.outcomeDelivery !== undefined };
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      // lib-dynamodb does not unmarshall the item an exception carries.
      const item = (error as { Item?: Parameters<typeof unmarshall>[0] }).Item;
      return refusedClaim(item ? (unmarshall(item) as { outcomeDelivery?: DeliveryRecord }) : undefined);
    }
  }

  async confirm(workItemId: string, claimedAt: string, now: Date): Promise<void> {
    await this.#documents.send(new UpdateCommand(confirmInput(requireEnv('TABLE_NAME'), workItemId, claimedAt, now)));
  }

  async release(workItemId: string, claimedAt: string): Promise<void> {
    try {
      await this.#documents.send(new UpdateCommand(releaseInput(requireEnv('TABLE_NAME'), workItemId, claimedAt)));
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    }
  }
}

/** The same guard in memory, for tests. `rows` are the work items that have a row; with none, every item has one. */
export class MemoryDeliveryLedger implements DeliveryLedger {
  readonly records = new Map<string, DeliveryRecord>();
  readonly #rows: Set<string> | undefined;

  constructor(rows?: Iterable<string>) {
    this.#rows = rows ? new Set(rows) : undefined;
  }

  async claim(workItemId: string, now: Date): Promise<Claim> {
    if (this.#rows && !this.#rows.has(workItemId)) return { kind: 'no-row' };
    const current = this.records.get(workItemId);
    const stale = new Date(now.getTime() - DELIVERY_LEASE_MS).toISOString();
    if (current && (current.deliveredAt || (!current.released && current.claimedAt >= stale))) return refusedClaim({ outcomeDelivery: current });
    const claimedAt = now.toISOString();
    this.records.set(workItemId, { claimedAt });
    return { kind: 'claimed', claimedAt, takeover: current !== undefined };
  }

  async confirm(workItemId: string, claimedAt: string, now: Date): Promise<void> {
    const current = this.records.get(workItemId);
    if (current?.claimedAt !== claimedAt) throw new Error('the claim is not ours');
    current.deliveredAt = now.toISOString();
  }

  async release(workItemId: string, claimedAt: string): Promise<void> {
    const current = this.records.get(workItemId);
    if (current?.claimedAt === claimedAt && !current.deliveredAt) current.released = true;
  }
}
