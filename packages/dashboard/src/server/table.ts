import 'server-only';

import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';

import type { Sender } from './aws.ts';

/** A table's item count and size, which DynamoDB refreshes about every six hours. */
export async function tableFacts(ddb: Sender, table: string): Promise<{ items?: number; bytes?: number }> {
  const result = (await ddb.send(new DescribeTableCommand({ TableName: table }))) as { Table?: { ItemCount?: number; TableSizeBytes?: number } };
  const t = result.Table;
  return { ...(typeof t?.ItemCount === 'number' ? { items: t.ItemCount } : {}), ...(typeof t?.TableSizeBytes === 'number' ? { bytes: t.TableSizeBytes } : {}) };
}
