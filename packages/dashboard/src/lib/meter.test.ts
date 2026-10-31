import assert from 'node:assert/strict';
import { test } from 'node:test';

import { meterLevel, percentOf } from './meter.ts';

test('a meter warns above 65% and is critical above 85%', () => {
  assert.equal(meterLevel(0), 'ok');
  assert.equal(meterLevel(65), 'ok');
  assert.equal(meterLevel(65.1), 'warn');
  assert.equal(meterLevel(85), 'warn');
  assert.equal(meterLevel(85.1), 'crit');
  assert.equal(meterLevel(140), 'crit');
});

test('a share of no limit is zero', () => {
  assert.equal(percentOf(5, undefined), 0);
  assert.equal(percentOf(5, 0), 0);
  assert.equal(percentOf(30, 60), 50);
});
