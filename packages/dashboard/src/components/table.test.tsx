import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { nextSort, sortRows, Table, type Column, type SortState } from './Table.tsx';

const router = { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} };
const render = (node: ReactNode) => renderToStaticMarkup(<AppRouterContext.Provider value={router as never}>{node}</AppRouterContext.Provider>);

interface Row {
  id: string;
  name: string;
  n?: number | null;
}
const ROWS: Row[] = [
  { id: 'a', name: 'b', n: 2 },
  { id: 'b', name: 'a', n: 10 },
  { id: 'c', name: 'c' },
];
const PLAIN: Column<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name },
  { key: 'n', header: 'N', align: 'right', render: (r) => String(r.n ?? '') },
];
const SORTABLE: Column<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name, sortValue: (r) => r.name },
  { key: 'n', header: 'N', align: 'right', render: (r) => String(r.n ?? ''), sortValue: (r) => r.n },
  { key: 'plain', header: 'Plain', render: () => 'x' },
];
const ids = (rows: Row[]) => rows.map((r) => r.id).join('');
const order = (html: string) => [...html.matchAll(/href="\/r\/(\w)"/g)].map((m) => m[1]).join('');

test('a table with no sort configured keeps its rows, header and row links as they were', () => {
  const html = render(<Table label="T" columns={PLAIN} rows={ROWS} rowKey={(r) => r.id} rowHref={(r) => `/r/${r.id}`} empty="none" />);
  assert.equal(order(html), 'abc');
  assert.ok(!html.includes('aria-sort'), html);
  assert.ok(!html.includes('<button'), html);
  assert.ok(html.includes('<th>Name</th><th class="right">N</th>'), html);
  assert.ok(html.includes('<tr class="row-link"><td><a class="row-anchor" href="/r/a">b</a></td>'), html);
});

test('the default sort orders the rows and shows its direction; other columns say none', () => {
  const html = render(<Table label="T" columns={SORTABLE} rows={ROWS} rowKey={(r) => r.id} rowHref={(r) => `/r/${r.id}`} empty="none" defaultSort={{ key: 'n', dir: 'desc' }} />);
  assert.equal(order(html), 'bac');
  assert.ok(html.includes('<th aria-sort="none"><button type="button" class="th-sort">Name</button></th>'), html);
  assert.ok(html.includes('aria-sort="descending"'), html);
  assert.ok(html.includes('<th>Plain</th>'), html);
  assert.equal(html.match(/aria-sort/g)?.length, 2);
  const asc = render(<Table label="T" columns={SORTABLE} rows={ROWS} rowKey={(r) => r.id} empty="none" defaultSort={{ key: 'name', dir: 'asc' }} />);
  assert.ok(asc.includes('<th aria-sort="ascending">'), asc);
});

test('sortable columns without a default sort start in the given order', () => {
  const html = render(<Table label="T" columns={SORTABLE} rows={ROWS} rowKey={(r) => r.id} rowHref={(r) => `/r/${r.id}`} empty="none" />);
  assert.equal(order(html), 'abc');
  assert.ok(!html.includes('ascending') && !html.includes('descending'), html);
});

test('sortRows orders strings and numbers both ways, with missing values last either way', () => {
  assert.equal(ids(sortRows(ROWS, SORTABLE, { key: 'name', dir: 'asc' })), 'bac');
  assert.equal(ids(sortRows(ROWS, SORTABLE, { key: 'name', dir: 'desc' })), 'cab');
  assert.equal(ids(sortRows(ROWS, SORTABLE, { key: 'n', dir: 'asc' })), 'abc');
  assert.equal(ids(sortRows(ROWS, SORTABLE, { key: 'n', dir: 'desc' })), 'bac');
  const withNaN = [...ROWS, { id: 'd', name: 'd', n: Number.NaN }, { id: 'e', name: 'e', n: null }];
  assert.equal(ids(sortRows(withNaN, SORTABLE, { key: 'n', dir: 'asc' })), 'abcde');
  assert.equal(ids(sortRows(withNaN, SORTABLE, { key: 'n', dir: 'desc' })), 'bacde');
});

test('sortRows compares digit runs as numbers, keeps ties in input order and does not touch its input', () => {
  const names = ['#12', '#9', 'build/10', 'build/2'].map((name, i) => ({ id: String(i), name }));
  assert.deepEqual(sortRows(names, SORTABLE, { key: 'name', dir: 'asc' }).map((r) => r.name), ['#9', '#12', 'build/2', 'build/10']);
  assert.deepEqual(sortRows(names, SORTABLE, { key: 'name', dir: 'desc' }).map((r) => r.name), ['build/10', 'build/2', '#12', '#9']);
  const ties = ['x', 'y', 'z'].map((id) => ({ id, name: 'same' }));
  assert.equal(ids(sortRows(ties, SORTABLE, { key: 'name', dir: 'asc' })), 'xyz');
  assert.equal(ids(sortRows(ties, SORTABLE, { key: 'name', dir: 'desc' })), 'xyz');
  assert.deepEqual(names.map((r) => r.name), ['#12', '#9', 'build/10', 'build/2']);
});

test('sortRows leaves the order alone for no sort, an unknown key or an unsortable column', () => {
  for (const sort of [undefined, { key: 'nope', dir: 'asc' }, { key: 'plain', dir: 'desc' }] as (SortState | undefined)[]) {
    assert.equal(ids(sortRows(ROWS, SORTABLE, sort)), 'abc');
  }
});

test('a click sorts a new column ascending and the same column the other way', () => {
  assert.deepEqual(nextSort(undefined, 'a'), { key: 'a', dir: 'asc' });
  assert.deepEqual(nextSort({ key: 'a', dir: 'desc' }, 'b'), { key: 'b', dir: 'asc' });
  assert.deepEqual(nextSort({ key: 'a', dir: 'asc' }, 'a'), { key: 'a', dir: 'desc' });
  assert.deepEqual(nextSort({ key: 'a', dir: 'desc' }, 'a'), { key: 'a', dir: 'asc' });
});
