import 'server-only';

import { GetQueryResultsCommand, StartQueryCommand, StopQueryCommand } from '@aws-sdk/client-cloudwatch-logs';

import type { Sender } from './aws.ts';

/** Factorial's log groups the views query (`docs/finding-a-run.md`). */
export const ADAPTER_LOG_GROUP = '/aws/lambda/factorial-github-issues-adapter';
export const INVOKER_LOG_GROUP = '/factorial/invoker';

export type InsightsRow = Record<string, string>;

/**
 * One Logs Insights query, waited on for at most `timeoutMs`. A query still
 * running then is stopped and reads as an error, never as no rows.
 */
export async function insights(logs: Sender, query: { groups: string[]; query: string; start: Date; end: Date }, options: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<InsightsRow[]> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = (await logs.send(
    new StartQueryCommand({ logGroupNames: query.groups, queryString: query.query, startTime: Math.floor(query.start.getTime() / 1000), endTime: Math.ceil(query.end.getTime() / 1000), limit: 1000 }),
  )) as { queryId?: string };
  const id = started.queryId;
  if (!id) throw new Error('Logs Insights returned no query id');
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  for (;;) {
    const result = (await logs.send(new GetQueryResultsCommand({ queryId: id }))) as { status?: string; results?: { field?: string; value?: string }[][] };
    if (result.status === 'Complete') {
      return (result.results ?? []).map((fields) => Object.fromEntries(fields.flatMap((f) => (f.field && f.value !== undefined && !f.field.startsWith('@ptr') ? [[f.field, f.value]] : []))));
    }
    if (result.status === 'Failed' || result.status === 'Cancelled' || result.status === 'Timeout') throw new Error(`Logs Insights query ${result.status.toLowerCase()}`);
    if (Date.now() > deadline) {
      await logs.send(new StopQueryCommand({ queryId: id })).catch(() => undefined);
      throw new Error('Logs Insights query took too long');
    }
    await sleep(options.pollMs ?? 400);
  }
}
