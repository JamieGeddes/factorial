import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareItems, costOf, matchesFilter, matchesSearch, summarise } from './work-items.ts';
import type { LedgerRow } from './records.ts';

const NOW = Date.parse('2026-11-01T10:10:00Z');
const base = (fields: Partial<LedgerRow> = {}): LedgerRow => ({
  workItemId: '7f93ccb0-d53d-11f1-8851-ff488f20a8b2',
  createdAt: '2026-11-01T10:00:00Z',
  workItem: { title: 'Do a thing', requestedBy: 'jamie', source: { type: 'github-issue', id: '201', url: 'https://example.invalid' }, repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' } },
  ...fields,
});

test('a row becomes the table row: source, reference, links built by the app, review mean', () => {
  const s = summarise(base({ result: 'pr-opened', prNumber: 226, branch: 'factorial/x', reviewVerdict: 'approve', reviewScores: { a: 4, b: 5 } }), undefined, NOW);
  assert.equal(s.source.label, 'GitHub issue');
  assert.equal(s.source.ref, '#201');
  // The source's own URL is never used: the link is built from the repository fields.
  assert.equal(s.source.url, 'https://github.com/JamieGeddes/factorial/issues/201');
  assert.deepEqual(s.pullRequest, { number: 226, url: 'https://github.com/JamieGeddes/factorial/pull/226' });
  assert.deepEqual(s.review, { verdict: 'approve', mean: 4.5 });
});

test('a rework names its pull request', () => {
  const s = summarise(base({ workItem: { title: 't', source: { type: 'github-pull-request-comment', id: '9' }, inReplyTo: { kind: 'pull-request', number: 189 }, repository: { owner: 'a', name: 'b' } } }), undefined, NOW);
  assert.equal(s.source.label, 'PR comment');
  assert.equal(s.source.ref, 'PR #189');
});

test('cost sums the runs, and the live run while it has no record', () => {
  const stages = { Build: { startedAt: '1', run: { costUsd: 0.5 } }, Review: { startedAt: '2' } };
  assert.equal(costOf(base({ stages })), 0.5);
  assert.equal(costOf(base({ stages, live: { stage: 'review', round: 1, costUsd: 0.25 } })), 0.75);
  assert.equal(costOf(base({ stages, live: { stage: 'build', round: 1, costUsd: 0.25 } })), 0.5);
  assert.equal(costOf(base()), undefined);
});

test('the filters', () => {
  const running = summarise(base({ stages: { Build: { startedAt: '2026-11-01T10:01:00Z' } }, live: { at: '2026-11-01T10:09:50Z' } }), undefined, NOW);
  const stale = summarise(base({ stages: { Build: { startedAt: '2026-11-01T10:01:00Z' } }, live: { at: '2026-11-01T10:05:00Z' } }), undefined, NOW);
  const waiting = summarise(base({ stages: { Test: { startedAt: '2026-11-01T10:01:00Z' } } }), undefined, NOW);
  const done = summarise(base({ result: 'no-changes' }), undefined, NOW);
  const failed = summarise(base({ result: 'invalid-plan' }), undefined, NOW);
  const refused = summarise(base({ result: 'refused' }), undefined, NOW);
  assert.equal(matchesFilter(running, 'running'), true);
  assert.equal(matchesFilter(waiting, 'running'), false);
  assert.equal(matchesFilter(waiting, 'waiting'), true);
  assert.equal(matchesFilter(done, 'finished'), true);
  assert.equal(matchesFilter(failed, 'attention'), true);
  assert.equal(matchesFilter(stale, 'attention'), true);
  assert.equal(matchesFilter(running, 'attention'), false);
  assert.equal(matchesFilter(refused, 'refused'), true);
  assert.equal(refused.stage, 'Intake');
});

test('search covers id, title, branch and pull request', () => {
  const s = summarise(base({ branch: 'factorial/abc', prNumber: 77, result: 'pr-opened' }), undefined, NOW);
  for (const q of ['7f93ccb0', 'a THING', 'factorial/abc', '#77', 'pr #77', '']) assert.equal(matchesSearch(s, q), true, q);
  assert.equal(matchesSearch(s, 'nothing'), false);
});

test('running and waiting first, then newest first', () => {
  const old = summarise(base({ createdAt: '2026-11-01T09:00:00Z', result: 'failed' }), undefined, NOW);
  const recent = summarise(base({ createdAt: '2026-11-01T11:00:00Z', result: 'failed' }), undefined, NOW);
  const running = summarise(base({ createdAt: '2026-11-01T08:00:00Z' }), undefined, NOW);
  assert.deepEqual([old, recent, running].sort(compareItems), [running, recent, old]);
});

test('untrusted text loses control and bidirectional characters', () => {
  const s = summarise(base({ workItem: { title: 'a‮b\u0007c', source: { type: 'github-issue', id: '1' } } }), undefined, NOW);
  assert.equal(s.title, 'abc');
});
