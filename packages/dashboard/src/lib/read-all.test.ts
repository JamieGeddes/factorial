import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readAll } from './read-all.ts';

interface Page {
  items: { id: string }[];
  total: number;
  nextCursor?: string;
}
const item = (id: string) => ({ id });

/** A list served `size` at a time with offset cursors, like /api/work-items. */
function served(all: string[], size: number, calls: (string | undefined)[] = []) {
  return async (cursor: string | undefined): Promise<Page> => {
    calls.push(cursor);
    const offset = cursor ? Number(cursor) : 0;
    return { items: all.slice(offset, offset + size).map(item), total: all.length, ...(offset + size < all.length ? { nextCursor: String(offset + size) } : {}) };
  };
}

test('every page is read by following the cursor until there is none', async () => {
  const calls: (string | undefined)[] = [];
  const result = await readAll(served(['a', 'b', 'c', 'd', 'e'], 2, calls));
  assert.deepEqual(result.items.map((i) => i.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(result.total, 5);
  assert.ok(!('nextCursor' in result));
  assert.deepEqual(calls, [undefined, '2', '4']);
});

test('a list in one page is read once', async () => {
  const calls: (string | undefined)[] = [];
  const result = await readAll(served(['a', 'b'], 500, calls));
  assert.equal(result.items.length, 2);
  assert.deepEqual(calls, [undefined]);
});

test('a row repeated across pages is kept once, the first', async () => {
  const pages: Page[] = [
    { items: [item('a'), item('b')], total: 3, nextCursor: '2' },
    { items: [item('b'), item('c')], total: 3 },
  ];
  let n = 0;
  const result = await readAll(async () => pages[n++]!);
  assert.deepEqual(result.items.map((i) => i.id), ['a', 'b', 'c']);
});

test('a cursor that repeats ends the read', async () => {
  let n = 0;
  const result = await readAll(async (): Promise<Page> => ({ items: [item(`r${n++}`)], total: 9, nextCursor: 'same' }));
  assert.deepEqual(result.items.map((i) => i.id), ['r0', 'r1']);
});

test('a page that fails fails the read', async () => {
  let n = 0;
  await assert.rejects(
    readAll(async (): Promise<Page> => {
      if (n++ === 1) throw new Error('HTTP 500');
      return { items: [item('a')], total: 2, nextCursor: '1' };
    }),
    /HTTP 500/,
  );
});
