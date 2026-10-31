import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stubClient } from '../../test/stubs.ts';
import { ID } from '../../test/stubs.ts';
import { metricData } from './cloudwatch.ts';
import { insights } from './logs.ts';
import { rpmQuotaName, tpmQuotaName } from './ops.ts';
import { stateMachineFacts } from './stepfunctions.ts';
import { createUsageRecords, isUsageKey } from './usage-records.ts';

test('usage records: only usage.json keys under a work item, each read once and kept', async () => {
  const reads: string[] = [];
  const records = createUsageRecords({
    once: async (key) => {
      reads.push(key);
      return key.endsWith('/review/usage.json') ? undefined : JSON.stringify({ calls: [{ inputTokens: 1, outputTokens: 1, model: 'm.anthropic.claude-a-1-0', durationMs: 5 }], retries: 1 });
    },
  });
  const keys = [`${ID}/1/build/usage.json`, `${ID}/1/build/round-2/usage.json`, `${ID}/1/review/usage.json`, `${ID}/1/../x/usage.json`, 'other/usage.json'];
  const first = await records.many(keys);
  assert.deepEqual([...first.keys()], [`${ID}/1/build/usage.json`, `${ID}/1/build/round-2/usage.json`]);
  assert.equal(first.get(`${ID}/1/build/usage.json`)?.retries, 1);
  await records.many(keys);
  // The two that exist are kept; the review's, not written yet, is read again.
  assert.deepEqual(reads.sort(), [`${ID}/1/build/round-2/usage.json`, `${ID}/1/build/usage.json`, `${ID}/1/review/usage.json`, `${ID}/1/review/usage.json`].sort());
  assert.equal(isUsageKey(`${ID}/1/build/transcript.jsonl`), false);
});

test('metric data: every query by id, sorted by time, an empty series when there is no data', async () => {
  const cw = stubClient({
    GetMetricDataCommand: () => ({
      MetricDataResults: [
        { Id: 'a', Timestamps: [new Date(2000), new Date(1000)], Values: [2, 1] },
        { Id: 'stranger', Timestamps: [new Date(1000)], Values: [9] },
      ],
    }),
  });
  const data = await metricData(cw, [{ id: 'a', namespace: 'AWS/Lambda', metric: 'Errors', dimensions: { FunctionName: 'f' }, stat: 'Sum', period: 60 }, { id: 'b', expression: 'SUM(x)', period: 60 }], new Date(0), new Date(5000));
  assert.deepEqual(data.get('a'), { timestamps: [1000, 2000], values: [1, 2] });
  assert.deepEqual(data.get('b'), { timestamps: [], values: [] });
  assert.equal(data.has('stranger'), false);
  const sent = cw.calls[0]?.input.MetricDataQueries as { MetricStat?: { Metric: { Dimensions: unknown[] } } }[];
  assert.deepEqual(sent[0]?.MetricStat?.Metric.Dimensions, [{ Name: 'FunctionName', Value: 'f' }]);
});

test('Logs Insights: polls until complete, and a query that runs too long is stopped and reads as an error', async () => {
  let polls = 0;
  const logs = stubClient({
    StartQueryCommand: () => ({ queryId: 'q' }),
    GetQueryResultsCommand: () => (++polls < 3 ? { status: 'Running' } : { status: 'Complete', results: [[{ field: 'n', value: '4' }, { field: 'outcome', value: 'ignored' }, { field: '@ptr', value: 'x' }]] }),
    StopQueryCommand: () => ({}),
  });
  const rows = await insights(logs, { groups: ['/g'], query: 'stats count()', start: new Date(0), end: new Date(1000) }, { sleep: async () => {} });
  assert.deepEqual(rows, [{ n: '4', outcome: 'ignored' }]);
  const slow = stubClient({ StartQueryCommand: () => ({ queryId: 'q' }), GetQueryResultsCommand: () => ({ status: 'Running' }), StopQueryCommand: () => ({}) });
  await assert.rejects(insights(slow, { groups: ['/g'], query: 'q', start: new Date(0), end: new Date(1) }, { timeoutMs: 0, sleep: async () => {} }), /took too long/);
  assert.ok(slow.calls.some((c) => c.name === 'StopQueryCommand'));
});

test('state machine: running, failed since midnight (newest first, stopping at the day before) and the live version', async () => {
  const day = Date.parse('2026-11-01T00:00:00Z');
  const sfn = stubClient({
    ListExecutionsCommand: (input) =>
      input.statusFilter === 'RUNNING'
        ? { executions: [{}, {}] }
        : input.nextToken
          ? { executions: [{ startDate: new Date(day - 3 * 86_400_000), stopDate: new Date(day - 3 * 86_400_000) }], nextToken: 'again' }
          : { executions: [{ startDate: new Date(day + 3_600_000), stopDate: new Date(day + 3_700_000) }, { startDate: new Date(day - 3_600_000), stopDate: new Date(day - 3_000_000) }], nextToken: 'more' },
    DescribeStateMachineAliasCommand: () => ({ routingConfiguration: [{ stateMachineVersionArn: 'arn:aws:states:eu-west-1:000000000000:stateMachine:factorial-work:127', weight: 0 }, { stateMachineVersionArn: 'arn:aws:states:eu-west-1:000000000000:stateMachine:factorial-work:128', weight: 100 }] }),
  });
  assert.deepEqual(await stateMachineFacts(sfn, 'arn:sm', 'arn:alias', day), { running: 2, failedToday: 1, liveVersion: '128' });
  // Two pages of failures, then it stops: the second page started before the day before.
  assert.equal(sfn.calls.filter((c) => c.input.statusFilter === 'FAILED').length, 2);
});

test('the quota names for a model', () => {
  assert.ok(tpmQuotaName('global.anthropic.claude-sonnet-5-5')?.test('Global cross-region model inference tokens per minute for Anthropic Claude Sonnet 5.5'));
  assert.ok(tpmQuotaName('eu.anthropic.claude-haiku-5-5')?.test('Cross-region model inference tokens per minute for Anthropic Claude Haiku 5.5'));
  assert.equal(tpmQuotaName('eu.anthropic.claude-haiku-5-5')?.test('Global cross-region model inference tokens per minute for Anthropic Claude Haiku 5.5'), false);
  assert.ok(rpmQuotaName('global.anthropic.claude-sonnet-5-5')?.test('Global cross-region model inference requests per minute for Anthropic Claude Sonnet 5.5'));
  assert.equal(tpmQuotaName('compaction'), undefined);
});
