import 'server-only';

import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { RESULT_SINCE } from '../lib/status.ts';
import type { LedgerRow } from '../lib/records.ts';
import { memo, memoByKey } from './cache.ts';
import type { Sender } from './aws.ts';

/**
 * The `factorial-work-items` ledger, read only. Lists and aggregates scan the
 * table: at today's volume (hundreds of rows) a scan is enough, and it is
 * read at most once every few seconds however many views want it.
 */
export interface Ledger {
  /** Every row. */
  list(): Promise<LedgerRow[]>;
  /** Rows with no `result` yet, created since #165 (older rows never got one). */
  running(): Promise<LedgerRow[]>;
  get(workItemId: string): Promise<LedgerRow | undefined>;
}

export interface LedgerOptions {
  table: () => Promise<string>;
  ttlMs?: number;
  resultSince?: string;
}

async function scanAll(documents: Sender, input: Record<string, unknown>): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = (await documents.send(new ScanCommand({ ...input, ...(start ? { ExclusiveStartKey: start } : {}) } as never))) as {
      Items?: LedgerRow[];
      LastEvaluatedKey?: Record<string, unknown>;
    };
    rows.push(...(page.Items ?? []));
    start = page.LastEvaluatedKey;
  } while (start);
  return rows;
}

export function createLedger(documents: Sender, options: LedgerOptions): Ledger {
  const ttl = options.ttlMs ?? 5_000;
  const since = options.resultSince ?? RESULT_SINCE;
  const all = memo(async () => scanAll(documents, { TableName: await options.table() }), ttl);
  const running = memo(
    async () =>
      scanAll(documents, {
        TableName: await options.table(),
        FilterExpression: 'attribute_not_exists(#result) AND #createdAt >= :since',
        ExpressionAttributeNames: { '#result': 'result', '#createdAt': 'createdAt' },
        ExpressionAttributeValues: { ':since': since },
      }),
    ttl,
  );
  const one = memoByKey(async (workItemId: string) => {
    const result = (await documents.send(new GetCommand({ TableName: await options.table(), Key: { workItemId } }))) as { Item?: LedgerRow };
    return result.Item;
  }, ttl);
  return { list: () => all.get(), running: () => running.get(), get: one };
}
