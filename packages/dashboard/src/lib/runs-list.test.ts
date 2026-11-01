import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LedgerRow } from './records.ts';
import { filterRuns, matchesRunSearch, runsEmptyMessage } from './runs-list.ts';
import { summarise } from './work-items.ts';

const NOW = Date.parse('2026-11-01T10:10:00Z');
const base = (fields: Partial<LedgerRow> = {}): LedgerRow => ({
  workItemId: '7f93ccb0-d53d-11f1-8851-ff488f20a8b2',
  createdAt: '2026-11-01T10:00:00Z',
  workItem: { title: 'Do a thing', requestedBy: 'jamie', source: { type: 'github-issue', id: '201', url: 'https://example.invalid' }, repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' } },
  ...fields,
});

test('search covers reference, title and id, and nothing else', () => {
  const s = summarise(base({ branch: 'factorial/abc', prNumber: 77, result: 'pr-opened' }), undefined, NOW);
  for (const q of ['#201', 'a THING', '7f93ccb0', '  #201  ', '']) assert.equal(matchesRunSearch(s, q), true, q);
  for (const q of ['factorial/abc', '#77', 'nothing']) assert.equal(matchesRunSearch(s, q), false, q);
});

test('the status filters and the search narrow the list together', () => {
  const running = summarise(base({ workItemId: 'a1', stages: { Build: { startedAt: '2026-11-01T10:01:00Z' } }, live: { at: '2026-11-01T10:09:50Z' } }), undefined, NOW);
  const done = summarise(base({ workItemId: 'b2', result: 'no-changes', workItem: { ...base().workItem, title: 'Other' } }), undefined, NOW);
  const failed = summarise(base({ workItemId: 'c3', result: 'failed' }), undefined, NOW);
  const items = [running, done, failed];
  assert.deepEqual(filterRuns(items, { filter: 'all', q: '' }), items);
  assert.deepEqual(filterRuns(items, { filter: 'running', q: '' }), [running]);
  assert.deepEqual(filterRuns(items, { filter: 'finished', q: '' }), [done]);
  assert.deepEqual(filterRuns(items, { filter: 'attention', q: '' }), [failed]);
  assert.deepEqual(filterRuns(items, { filter: 'all', q: 'other' }), [done]);
  assert.deepEqual(filterRuns(items, { filter: 'attention', q: 'other' }), []);
});

test('the empty state names the active filters', () => {
  assert.equal(runsEmptyMessage({ filter: 'all', q: '' }), 'No item has an agent run yet.');
  assert.equal(runsEmptyMessage({ filter: 'running', q: '  ' }), 'No runs match. Clear the Running filter to see more.');
  assert.equal(runsEmptyMessage({ filter: 'all', q: ' abc ' }), 'No runs match. Clear the search “abc” to see more.');
  assert.equal(runsEmptyMessage({ filter: 'attention', q: 'abc' }), 'No runs match. Clear the Needs attention filter or the search “abc” to see more.');
});
