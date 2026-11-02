import assert from 'node:assert/strict';
import { test } from 'node:test';

import { clampPage, DEFAULT_PAGE_SIZE, pageCount, pageRange, pageRows, parsePage, rangeText, refine, turnTo, withPageParam } from './paging.ts';

test('the default page size is 50 and rows fill pages exactly at the boundary', () => {
  assert.equal(DEFAULT_PAGE_SIZE, 50);
  assert.equal(pageCount(0), 0);
  assert.equal(pageCount(1), 1);
  assert.equal(pageCount(50), 1);
  assert.equal(pageCount(51), 2);
  assert.equal(pageCount(100), 2);
  assert.equal(pageCount(101), 3);
  assert.equal(pageCount(7, 3), 3);
});

test('a page is brought into the pages there are', () => {
  assert.equal(clampPage(0, 3), 1);
  assert.equal(clampPage(-4, 3), 1);
  assert.equal(clampPage(2, 3), 2);
  assert.equal(clampPage(9, 3), 3);
  assert.equal(clampPage(5, 0), 1);
  assert.equal(clampPage(Number.NaN, 3), 1);
});

test('the page parameter is a positive whole number, otherwise page 1', () => {
  assert.equal(parsePage('3'), 3);
  assert.equal(parsePage(['4', '5']), 4);
  for (const bad of [undefined, null, '', '0', '-2', '1.5', 'x', '2x', ' ', '99999999999999999999']) assert.equal(parsePage(bad), 1, String(bad));
});

test('a page holds the rows of its range, the last one the remainder, and a stale page shows the last', () => {
  const rows = Array.from({ length: 120 }, (_, i) => i + 1);
  assert.deepEqual(pageRows(rows, 1).length, 50);
  assert.equal(pageRows(rows, 1)[0], 1);
  assert.equal(pageRows(rows, 2)[0], 51);
  assert.deepEqual(pageRows(rows, 3), rows.slice(100));
  assert.deepEqual(pageRows(rows, 9), rows.slice(100));
  assert.deepEqual(pageRows(rows.slice(0, 50), 1), rows.slice(0, 50));
  assert.deepEqual(pageRows(rows.slice(0, 51), 2), [51]);
  assert.deepEqual(pageRows([], 4), []);
  assert.deepEqual(pageRows(rows, 2, 10), rows.slice(10, 20));
});

test('the range a page covers reads x-y of z', () => {
  assert.deepEqual(pageRange(120, 1), { from: 1, to: 50, count: 3 });
  assert.deepEqual(pageRange(120, 3), { from: 101, to: 120, count: 3 });
  assert.deepEqual(pageRange(120, 8), { from: 101, to: 120, count: 3 });
  assert.deepEqual(pageRange(0, 1), { from: 0, to: 0, count: 0 });
  assert.equal(rangeText(pageRange(120, 2), 120), '51-100 of 120');
  assert.equal(rangeText(pageRange(51, 2), 51), '51-51 of 51');
});

test('page 1 needs no parameter, and other pages sit beside the others', () => {
  const base = new URLSearchParams('filter=done&q=x');
  assert.equal(withPageParam(base, 1).toString(), 'filter=done&q=x');
  assert.equal(withPageParam(base, 3).toString(), 'filter=done&q=x&page=3');
  assert.equal(withPageParam(new URLSearchParams('page=4&q=x'), 1).toString(), 'q=x');
  assert.equal(withPageParam(new URLSearchParams('page=4'), 2).toString(), 'page=2');
  assert.equal(base.toString(), 'filter=done&q=x', 'the input is not changed');
});

test('a change of filter returns to page 1; turning a page keeps the filters', () => {
  const state = { query: { filter: 'all', q: '' }, page: 4 };
  assert.deepEqual(refine(state, { q: 'x' }), { query: { filter: 'all', q: 'x' }, page: 1 });
  assert.deepEqual(refine(state, { filter: 'done' }), { query: { filter: 'done', q: '' }, page: 1 });
  assert.deepEqual(turnTo(state, 2), { query: { filter: 'all', q: '' }, page: 2 });
});
