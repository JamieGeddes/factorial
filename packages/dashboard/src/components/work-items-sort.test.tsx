import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { LedgerRow } from '../lib/records.ts';
import { summarise, type WorkItemSummary } from '../lib/work-items.ts';
import { sortRows } from './Table.tsx';
import { durationMs, workItemColumns, WorkItemsTable } from './work-items/WorkItemsTable.tsx';

const router = { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} };
const render = (node: ReactNode) => renderToStaticMarkup(<AppRouterContext.Provider value={router as never}>{node}</AppRouterContext.Provider>);

const NOW = Date.parse('2026-11-01T12:00:00Z');
const row = (n: string, ref: string, fields: Partial<LedgerRow>): LedgerRow => ({
  workItemId: `${n.repeat(8)}-d53d-11f1-8851-ff488f20a8b2`,
  createdAt: '2026-11-01T09:00:00Z',
  workItem: { title: `Title ${n}`, source: { type: 'github-issue', id: ref.slice(1) }, repository: { owner: 'JamieGeddes', name: 'factorial' } },
  ...fields,
});
const item = (n: string, ref: string, fields: Partial<LedgerRow>, over: Record<string, unknown> = {}): WorkItemSummary => ({ ...summarise(row(n, ref, fields), undefined, NOW), ...over }) as WorkItemSummary;

// Each column's order is distinct from the others, so a wrong sort key shows.
const ITEMS: WorkItemSummary[] = [
  item('a', '#9', {}, {
    source: { type: 'github-issue', label: 'GitHub issue', ref: '#9' },
    repository: { owner: 'Zed', name: 'app' },
    branch: 'b-2',
    status: { label: 'Failed', kind: 'failed' } as never,
    stage: 'Review',
    attempt: 3,
    createdAt: '2026-11-01T09:00:00Z',
    endedAt: '2026-11-01T09:10:00Z',
    costUsd: 5,
    review: { verdict: 'approve', mean: 3 },
  }),
  item('b', '#12', {}, {
    source: { type: 'github-pull-request', label: 'Pull request', ref: '#12' },
    repository: { owner: 'Alpha', name: 'zeta' },
    branch: 'b-1',
    status: { label: 'Running', kind: 'running' } as never,
    stage: 'Build',
    attempt: 1,
    createdAt: '2026-11-01T11:00:00Z',
    endedAt: '2026-11-01T11:01:00Z',
    costUsd: 1,
    review: { verdict: 'approve', mean: 4.5 },
  }),
  item('c', '#100', {}, {
    source: { type: 'github-workflow-run', label: 'Checks failed', ref: '#100' },
    repository: { owner: 'Alpha', name: 'zeta' },
    branch: 'b-10',
    status: { label: 'Merged', kind: 'done' } as never,
    stage: 'Test',
    attempt: 2,
    createdAt: '2026-11-01T10:00:00Z',
    endedAt: '2026-11-01T10:30:00Z',
    costUsd: 0.5,
    review: { verdict: 'changes', mean: 1.2 },
  }),
  item('d', '#20', {}, {
    source: { type: 'github-pull-request-review', label: 'PR review', ref: '#20' },
    repository: { owner: 'Alpha', name: 'app' },
    branch: 'main',
    status: { label: 'Refused', kind: 'failed' } as never,
    result: 'refused',
    stage: undefined,
    attempt: 4,
    createdAt: '2026-11-01T08:00:00Z',
    endedAt: '2026-11-01T08:00:05Z',
    costUsd: 2,
    review: { verdict: 'approve', mean: 2 },
  }),
];
const letters = (items: { id: string }[]) => items.map((i) => i.id[0]).join('');
const columns = workItemColumns(NOW);
const by = (rows: WorkItemSummary[], key: string, dir: 'asc' | 'desc') => letters(sortRows(rows, columns, { key, dir }));

test('every Work items column has a sort value', () => {
  assert.deepEqual(columns.map((c) => [c.key, typeof c.sortValue]), ['item', 'source', 'repository', 'status', 'stage', 'attempt', 'duration', 'cost', 'review'].map((k) => [k, 'function']));
});

test('every Work items column sorts both ways', () => {
  // Reference: #9 < #12 < #20 < #100 (digit runs compare as numbers).
  assert.equal(by(ITEMS, 'item', 'asc'), 'abdc');
  assert.equal(by(ITEMS, 'item', 'desc'), 'cdba');
  // Checks failed < GitHub issue < PR review < Pull request.
  assert.equal(by(ITEMS, 'source', 'asc'), 'cadb');
  assert.equal(by(ITEMS, 'source', 'desc'), 'bdac');
  // owner/name, then branch: Alpha/app main < Alpha/zeta b-1 < Alpha/zeta b-10 < Zed/app.
  assert.equal(by(ITEMS, 'repository', 'asc'), 'dbca');
  assert.equal(by(ITEMS, 'repository', 'desc'), 'acbd');
  // Failed < Merged < Refused < Running.
  assert.equal(by(ITEMS, 'status', 'asc'), 'acdb');
  assert.equal(by(ITEMS, 'status', 'desc'), 'bdca');
  // Build < Intake (the refused turn) < Review < Test.
  assert.equal(by(ITEMS, 'stage', 'asc'), 'bdac');
  assert.equal(by(ITEMS, 'stage', 'desc'), 'cadb');
  assert.equal(by(ITEMS, 'attempt', 'asc'), 'bcad');
  assert.equal(by(ITEMS, 'attempt', 'desc'), 'dacb');
  // Elapsed: d 5s (refused: none), b 1m, a 10m, c 30m.
  assert.equal(by(ITEMS, 'duration', 'asc'), 'bacd');
  assert.equal(by(ITEMS, 'duration', 'desc'), 'cabd');
  assert.equal(by(ITEMS, 'cost', 'asc'), 'cbda');
  assert.equal(by(ITEMS, 'cost', 'desc'), 'adbc');
  assert.equal(by(ITEMS, 'review', 'asc'), 'cdab');
  assert.equal(by(ITEMS, 'review', 'desc'), 'badc');
});

test('an item with no value in a column sorts last whichever way', () => {
  const { createdAt: _created, endedAt: _ended, costUsd: _cost, stage: _stage, review: _review, repository: _repo, ...rest } = ITEMS[0]!;
  const bare: WorkItemSummary = { ...rest, id: 'e'.repeat(8) + '-d53d-11f1-8851-ff488f20a8b2', incomplete: true, source: { type: 'x', label: '', ref: '' } };
  const items = [...ITEMS, bare];
  for (const key of ['item', 'source', 'repository', 'stage', 'duration', 'cost', 'review']) {
    assert.equal(by(items, key, 'asc').at(-1), 'e', `${key} ascending`);
    assert.equal(by(items, key, 'desc').at(-1), 'e', `${key} descending`);
  }
  // The refused turn has no duration, though it has a created and ended time.
  assert.equal(by(items, 'duration', 'asc').slice(-2), 'de');
  assert.equal(by(items, 'duration', 'desc').slice(-2), 'de');
});

test('a running item lasts from its creation to now; a refused turn has no duration', () => {
  const { endedAt: _ended, ...running } = ITEMS[1]!;
  assert.equal(durationMs(running, NOW), NOW - Date.parse('2026-11-01T11:00:00Z'));
  assert.equal(durationMs(running, 0), 0);
  assert.equal(durationMs(ITEMS[0]!, NOW), 600_000);
  assert.equal(durationMs(ITEMS[3]!, NOW), undefined);
  assert.equal(by([ITEMS[2]!, running], 'duration', 'desc'), 'bc');
});

test('with no header clicked the rows keep the server order and no header is marked', () => {
  const html = render(<WorkItemsTable items={ITEMS} empty="none" />);
  assert.equal([...html.matchAll(/href="\/work-items\/(\w)/g)].map((m) => m[1]).join(''), 'abcd');
  assert.equal(html.match(/aria-sort="none"><button type="button" class="th-sort">/g)?.length, 9);
  assert.ok(!html.includes('aria-sort="ascending"') && !html.includes('aria-sort="descending"'));
});
