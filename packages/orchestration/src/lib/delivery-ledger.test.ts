import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DELIVERY_LEASE_MS, MemoryDeliveryLedger, claimInput, confirmInput, refusedClaim, releaseInput } from './delivery-ledger.ts';

const ID = '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c';
const T0 = new Date('2026-10-31T12:00:00.000Z');
const later = (ms: number): Date => new Date(T0.getTime() + ms);

describe('the claim', () => {
  it('needs the row, and no confirmed or live claim', () => {
    const input = claimInput('t', ID, T0);
    assert.match(input.ConditionExpression ?? '', /^attribute_exists\(workItemId\) AND/);
    assert.match(input.ConditionExpression ?? '', /attribute_not_exists\(#delivery\.deliveredAt\)/);
    assert.deepEqual(input.ExpressionAttributeValues, {
      ':claim': { claimedAt: T0.toISOString() },
      ':true': true,
      ':stale': new Date(T0.getTime() - DELIVERY_LEASE_MS).toISOString(),
    });
    assert.equal(input.ReturnValues, 'UPDATED_OLD');
    assert.equal(input.ReturnValuesOnConditionCheckFailure, 'ALL_OLD');
  });

  it('confirms and releases only its own claim', () => {
    assert.equal(confirmInput('t', ID, 'c', T0).ConditionExpression, '#delivery.claimedAt = :at');
    assert.equal(releaseInput('t', ID, 'c').ConditionExpression, '#delivery.claimedAt = :at AND attribute_not_exists(#delivery.deliveredAt)');
  });

  it('reads a refused claim from the row as it was', () => {
    assert.deepEqual(refusedClaim(undefined), { kind: 'no-row' });
    assert.deepEqual(refusedClaim({ outcomeDelivery: { claimedAt: 'a', deliveredAt: 'b' } }), { kind: 'delivered' });
    assert.deepEqual(refusedClaim({ outcomeDelivery: { claimedAt: 'a' } }), { kind: 'in-progress', claimedAt: 'a' });
  });
});

describe('the guard, in memory', () => {
  it('claims once, defers to a live claim, then lets the lapsed one be taken over', async () => {
    const ledger = new MemoryDeliveryLedger();
    assert.deepEqual(await ledger.claim(ID, T0), { kind: 'claimed', claimedAt: T0.toISOString(), takeover: false });
    assert.equal((await ledger.claim(ID, later(1_000))).kind, 'in-progress');
    assert.deepEqual(await ledger.claim(ID, later(DELIVERY_LEASE_MS + 1)), { kind: 'claimed', claimedAt: later(DELIVERY_LEASE_MS + 1).toISOString(), takeover: true });
  });

  it('lets a released claim be taken over at once', async () => {
    const ledger = new MemoryDeliveryLedger();
    await ledger.claim(ID, T0);
    await ledger.release(ID, T0.toISOString());
    const claim = await ledger.claim(ID, later(1));
    assert.equal(claim.kind === 'claimed' && claim.takeover, true);
  });

  it('never claims a confirmed delivery again', async () => {
    const ledger = new MemoryDeliveryLedger();
    await ledger.claim(ID, T0);
    await ledger.confirm(ID, T0.toISOString(), later(1));
    await ledger.release(ID, T0.toISOString());
    assert.deepEqual(await ledger.claim(ID, later(DELIVERY_LEASE_MS * 10)), { kind: 'delivered' });
  });

  it('claims nothing without a row', async () => {
    assert.deepEqual(await new MemoryDeliveryLedger([]).claim(ID, T0), { kind: 'no-row' });
  });
});
