import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OrderedFeed } from './feed.ts';

test('events come out once each, in order, whichever source brings them first', () => {
  const feed = new OrderedFeed<string>();
  // Subscribed first: live events 4 and 5 arrive before the chunks are read.
  assert.deepEqual(feed.offer(4, 'live-4'), []);
  assert.deepEqual(feed.offer(5, 'live-5'), []);
  assert.equal(feed.gap, true);
  assert.equal(feed.expected, 1);
  // The chunks hold 1 to 4: 4 is a repeat and the live copy is kept.
  assert.deepEqual(feed.offer(1, 'chunk-1'), ['chunk-1']);
  assert.deepEqual(feed.offer(2, 'chunk-2'), ['chunk-2']);
  assert.deepEqual(feed.offer(3, 'chunk-3'), ['chunk-3', 'live-4', 'live-5']);
  assert.deepEqual(feed.offer(4, 'chunk-4'), []);
  assert.equal(feed.gap, false);
  assert.deepEqual(feed.offer(6, 'live-6'), ['live-6']);
  assert.deepEqual(feed.offer(6, 'live-6-again'), []);
  assert.equal(feed.expected, 7);
});

test('an event without a whole-number seq is never taken', () => {
  const feed = new OrderedFeed<string>();
  assert.deepEqual(feed.offer(Number.NaN, 'x'), []);
  assert.deepEqual(feed.offer(1.5, 'x'), []);
  assert.equal(feed.gap, false);
});
