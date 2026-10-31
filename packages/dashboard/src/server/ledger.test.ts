import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stubClient, ID } from '../../test/stubs.ts';
import { createLedger } from './ledger.ts';
import { createThreads } from './threads.ts';

test('the ledger scans every page, and reads once per cache window', async () => {
  const documents = stubClient({
    ScanCommand: (input) => (input.ExclusiveStartKey ? { Items: [{ workItemId: 'b' }] } : { Items: [{ workItemId: 'a' }], LastEvaluatedKey: { workItemId: 'a' } }),
  });
  const ledger = createLedger(documents, { table: async () => 'factorial-work-items' });
  assert.deepEqual((await ledger.list()).map((r) => r.workItemId), ['a', 'b']);
  await ledger.list();
  assert.equal(documents.calls.length, 2);
  assert.equal(documents.calls[0]?.input.TableName, 'factorial-work-items');
});

test('running items are those with no result, created since #165', async () => {
  const documents = stubClient({ ScanCommand: () => ({ Items: [] }) });
  await createLedger(documents, { table: async () => 't', resultSince: '2026-10-31T13:22:52Z' }).running();
  const input = documents.calls[0]?.input ?? {};
  assert.equal(input.FilterExpression, 'attribute_not_exists(#result) AND #createdAt >= :since');
  assert.deepEqual(input.ExpressionAttributeValues, { ':since': '2026-10-31T13:22:52Z' });
});

test('one row and one thread by key', async () => {
  const documents = stubClient({ GetCommand: (input) => ({ Item: { ...(input.Key as object), status: 'x' } }), ScanCommand: () => ({ Items: [{ threadKey: 'k' }] }) });
  assert.equal((await createLedger(documents, { table: async () => 't' }).get(ID))?.workItemId, ID);
  const threads = createThreads(documents, async () => 'factorial-threads');
  assert.equal((await threads.get('k'))?.threadKey, 'k');
  assert.deepEqual([...(await threads.all()).keys()], ['k']);
});
