import assert from 'node:assert/strict';
import { test } from 'node:test';

import { niceMax, sparkPath } from './charts.ts';

test('axis maxima are round', () => {
  assert.equal(niceMax(0.7), 1);
  assert.equal(niceMax(17), 20);
  assert.equal(niceMax(23), 25);
  assert.equal(niceMax(410), 500);
  assert.equal(niceMax(0), 1);
});

test('a sparkline needs two points', () => {
  assert.equal(sparkPath([3]), undefined);
  assert.match(sparkPath([1, 2, 3])?.line ?? '', /^M2\.0,26\.0L36\.0,14\.0L70\.0,2\.0$/);
});
