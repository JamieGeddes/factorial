import 'server-only';

import { GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import type { ThreadRow } from '../lib/records.ts';
import { memo, memoByKey } from './cache.ts';
import type { Sender } from './aws.ts';

/** The `factorial-threads` table (#163), read only: one row per branch, with its pull request and what became of it. */
export interface Threads {
  /** Every thread, by key. */
  all(): Promise<Map<string, ThreadRow>>;
  get(threadKey: string): Promise<ThreadRow | undefined>;
}

export function createThreads(documents: Sender, table: () => Promise<string>, ttlMs = 5_000): Threads {
  const all = memo(async () => {
    const threads = new Map<string, ThreadRow>();
    let start: Record<string, unknown> | undefined;
    do {
      const page = (await documents.send(new ScanCommand({ TableName: await table(), ...(start ? { ExclusiveStartKey: start } : {}) }))) as {
        Items?: ThreadRow[];
        LastEvaluatedKey?: Record<string, unknown>;
      };
      for (const thread of page.Items ?? []) if (typeof thread.threadKey === 'string') threads.set(thread.threadKey, thread);
      start = page.LastEvaluatedKey;
    } while (start);
    return threads;
  }, ttlMs);
  const one = memoByKey(async (threadKey: string) => {
    const result = (await documents.send(new GetCommand({ TableName: await table(), Key: { threadKey } }))) as { Item?: ThreadRow };
    return result.Item;
  }, ttlMs);
  return { all: () => all.get(), get: one };
}
