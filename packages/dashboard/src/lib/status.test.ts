import assert from 'node:assert/strict';
import { test } from 'node:test';

import { currentStage, isStale, resultOf, statusPill } from './status.ts';
import type { LedgerRow } from './records.ts';

const NEW = '2026-11-01T10:00:00.000Z';
const row = (fields: Partial<LedgerRow>): LedgerRow => ({ workItemId: 'x', createdAt: NEW, ...fields });
const open = (stage: string, at = '2026-11-01T10:05:00.000Z') => ({ [stage]: { startedAt: at } });

test('a running item in Build or Review reads building or reviewing, with the round above 1', () => {
  assert.deepEqual(statusPill(row({ stages: open('Build') })), { label: 'building', tone: 'running' });
  assert.deepEqual(statusPill(row({ stages: { Build: { startedAt: 'a', endedAt: 'b' }, 'Build#2': { startedAt: 'c' } } })), { label: 'building r2', tone: 'running' });
  assert.deepEqual(statusPill(row({ stages: open('Review') })), { label: 'reviewing', tone: 'running' });
});

test('a running item in Test reads testing, styled as waiting', () => {
  assert.deepEqual(statusPill(row({ stages: open('Test') })), { label: 'testing', tone: 'waiting' });
});

test('a running item in any other stage reads the stage name', () => {
  assert.equal(statusPill(row({ stages: open('PrepareReview') })).label, 'prepare-review');
  assert.equal(statusPill(row({ stages: open('Intake') })).label, 'intake');
});

test('between stages, the last one that ran names it', () => {
  const stages = { Intake: { startedAt: '1', endedAt: '2' }, Prepare: { startedAt: '3', endedAt: '4' } };
  assert.deepEqual(currentStage(row({ stages })), { stage: 'Prepare', open: false });
});

test('pr-opened reads merged or closed once the thread records it', () => {
  const done = row({ result: 'pr-opened' });
  assert.deepEqual(statusPill(done), { label: 'pr-opened', tone: 'done' });
  assert.deepEqual(statusPill(done, { threadKey: 't', outcome: { state: 'merged', at: 'a', by: 'b' } }), { label: 'merged', tone: 'done' });
  assert.equal(statusPill(done, { threadKey: 't', outcome: { state: 'closed', at: 'a', by: 'b' } }).label, 'closed');
});

test('the other results read as named', () => {
  for (const result of ['pr-updated', 'no-changes', 'tests-failed', 'invalid-plan', 'failed']) assert.equal(statusPill(row({ result })).label, result);
  assert.equal(statusPill(row({ result: 'tests-failed' })).tone, 'failed');
});

test('failed with saved work reads incomplete and names the branch', () => {
  assert.deepEqual(statusPill(row({ result: 'failed', savedWork: true, branch: 'factorial/abc' })), { label: 'incomplete', tone: 'failed', note: 'Saved to factorial/abc' });
});

test('refused carries the code and the reason', () => {
  assert.deepEqual(statusPill(row({ result: 'refused', status: 'busy', refusedReason: 'The thread is busy.' })), { label: 'refused: busy', tone: 'refused', note: 'The thread is busy.' });
});

test('rows from before #165 have ended, their status standing in for the result', () => {
  assert.equal(resultOf(row({ createdAt: '2026-10-30T00:00:00Z', status: 'pr-opened' })), 'pr-opened');
  assert.equal(resultOf(row({ createdAt: '2026-10-30T00:00:00Z', status: 'busy', route: 'refuse' })), 'refused');
  assert.equal(resultOf(row({ status: 'building' })), undefined);
});

test('a running item whose live record is over a minute old is stale', () => {
  const now = Date.parse('2026-11-01T10:10:00Z');
  assert.equal(isStale(row({ live: { at: '2026-11-01T10:08:30Z' } }), now), true);
  assert.equal(isStale(row({ live: { at: '2026-11-01T10:09:30Z' } }), now), false);
  assert.equal(isStale(row({ live: { at: '2026-11-01T10:00:00Z', ended: true } }), now), false);
  assert.equal(isStale(row({ result: 'failed', live: { at: '2026-11-01T10:00:00Z' } }), now), false);
});
