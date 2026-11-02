import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { LedgerRow } from '../lib/records.ts';
import { summarise, type WorkItemSummary } from '../lib/work-items.ts';
import { pageSearch, readAllWorkItems, search, WorkItemsView, type Query, type WorkItemsData } from './work-items/WorkItemsView.tsx';

const router = { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} };
const render = (node: ReactNode) => renderToStaticMarkup(<AppRouterContext.Provider value={router as never}>{node}</AppRouterContext.Provider>);

const NOW = Date.parse('2026-11-01T12:00:00Z');
const ALL: Query = { filter: 'all', source: '', q: '' };
// Newest first, as the API returns them: Title-0 the newest.
const ITEMS: WorkItemSummary[] = Array.from({ length: 120 }, (_, i) => {
  const row: LedgerRow = {
    workItemId: `${String(i).padStart(8, '0')}-d53d-11f1-8851-ff488f20a8b2`,
    createdAt: new Date(NOW - i * 60_000).toISOString(),
    result: 'pr-opened',
    workItem: { title: `Title-${i}`, source: { type: 'github-issue', id: String(i) }, repository: { owner: 'JamieGeddes', name: 'factorial' } },
  };
  return summarise(row, undefined, NOW);
});
const data = (items: WorkItemSummary[]): Omit<WorkItemsData, 'nextCursor'> => ({ items, total: items.length, sources: [], counts: { running: 0, waiting: 0 } });
const titles = (html: string) => [...html.slice(html.indexOf('<table')).matchAll(/Title-(\d+)/g)].map((m) => Number(m[1]));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

test('Work items shows every item across pages, 50 to a page, with no cap note', () => {
  const first = render(<WorkItemsView initial={data(ITEMS)} initialQuery={ALL} />);
  assert.deepEqual(titles(first), range(0, 49));
  assert.match(first, /aria-live="polite"[^>]*>1-50 of 120</);
  assert.ok(!first.includes('Showing'), first);
  assert.match(first, /Refused turns are the system/);
  assert.deepEqual(titles(render(<WorkItemsView initial={data(ITEMS)} initialQuery={ALL} initialPage={2} />)), range(50, 99));
  const last = render(<WorkItemsView initial={data(ITEMS)} initialQuery={ALL} initialPage={3} />);
  assert.deepEqual(titles(last), range(100, 119));
  assert.match(last, />101-120 of 120</);
});

test('Work items shows no controls when everything fits one page', () => {
  const html = render(<WorkItemsView initial={data(ITEMS.slice(0, 50))} initialQuery={ALL} initialPage={2} />);
  assert.equal(titles(html).length, 50);
  assert.ok(!html.includes('pager'), html);
});

test('the page sits in the URL beside the filters, and never in the API request', () => {
  const query: Query = { filter: 'attention', source: 'github-issue', q: ' x ' };
  assert.equal(search(query), 'filter=attention&source=github-issue&q=x');
  assert.equal(pageSearch(query, 1), 'filter=attention&source=github-issue&q=x');
  assert.equal(pageSearch(query, 3), 'filter=attention&source=github-issue&q=x&page=3');
  assert.equal(pageSearch(ALL, 2), 'page=2');
  assert.equal(pageSearch(ALL, 1), '');
});

test('the view reads every page of the API, 500 at a time, following nextCursor', async () => {
  const urls: string[] = [];
  const result = await readAllWorkItems({ ...ALL, filter: 'running' }, async (url) => {
    urls.push(url);
    const cursor = new URL(url, 'http://h').searchParams.get('cursor');
    return cursor ? { ...data(ITEMS.slice(60)), total: 120 } : { ...data(ITEMS.slice(0, 60)), total: 120, nextCursor: '60' };
  });
  assert.deepEqual(urls, ['/api/work-items?filter=running&limit=500', '/api/work-items?filter=running&limit=500&cursor=60']);
  assert.equal(result.items.length, 120);
  assert.equal(result.total, 120);
  const bare: string[] = [];
  await readAllWorkItems(ALL, async (url) => (bare.push(url), data([])));
  assert.deepEqual(bare, ['/api/work-items?limit=500']);
});
