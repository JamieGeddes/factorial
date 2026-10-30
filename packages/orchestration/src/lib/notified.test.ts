import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemoryNotifyLedger, claimStartedInput, releaseStartedInput } from './notified.ts';

describe('the started claim', () => {
  it('writes startedNotifiedAt only on an existing row without one', () => {
    const input = claimStartedInput('table', 'wi-1', '2026-01-01T00:00:00.000Z');
    assert.equal(input.TableName, 'table');
    assert.deepEqual(input.Key, { workItemId: 'wi-1' });
    assert.equal(input.UpdateExpression, 'SET startedNotifiedAt = :at');
    assert.equal(input.ConditionExpression, 'attribute_exists(workItemId) AND attribute_not_exists(startedNotifiedAt)');
    assert.deepEqual(input.ExpressionAttributeValues, { ':at': '2026-01-01T00:00:00.000Z' });
  });

  it('is released only while it is still the claim made at that time', () => {
    const input = releaseStartedInput('table', 'wi-1', 'T');
    assert.equal(input.UpdateExpression, 'REMOVE startedNotifiedAt');
    assert.equal(input.ConditionExpression, 'startedNotifiedAt = :at');
    assert.deepEqual(input.ExpressionAttributeValues, { ':at': 'T' });
  });
});

describe('the in-memory ledger', () => {
  it('lets the first claim win', async () => {
    const ledger = new MemoryNotifyLedger();
    assert.equal(await ledger.claimStarted('wi-1', 'a'), true);
    assert.equal(await ledger.claimStarted('wi-1', 'b'), false);
    assert.equal(await ledger.claimStarted('wi-2', 'c'), true);
  });

  it('claims nothing for an item without a row', async () => {
    const ledger = new MemoryNotifyLedger(['wi-1']);
    assert.equal(await ledger.claimStarted('wi-2', 'a'), false);
    assert.equal(await ledger.claimStarted('wi-1', 'a'), true);
  });

  it('releases only its own claim', async () => {
    const ledger = new MemoryNotifyLedger();
    await ledger.claimStarted('wi-1', 'a');
    await ledger.releaseStarted('wi-1', 'other');
    assert.equal(await ledger.claimStarted('wi-1', 'b'), false);
    await ledger.releaseStarted('wi-1', 'a');
    assert.equal(await ledger.claimStarted('wi-1', 'b'), true);
  });
});
