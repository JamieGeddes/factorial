import assert from 'node:assert/strict';
import { it } from 'node:test';

import { Slots } from './slots.ts';

it('runs at most the slot count at once, in order, and frees a slot when work fails', async () => {
  const slots = new Slots(2);
  let running = 0;
  let peak = 0;
  const started: number[] = [];
  const job = (n: number, fail = false) =>
    slots.run(async () => {
      started.push(n);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      if (fail) throw new Error(`job ${n}`);
      return n;
    });
  const results = await Promise.allSettled([job(1), job(2, true), job(3), job(4), job(5)]);
  assert.equal(peak, 2);
  assert.deepEqual(started, [1, 2, 3, 4, 5]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
  assert.equal(await slots.run(async () => 'free again'), 'free again');
});
