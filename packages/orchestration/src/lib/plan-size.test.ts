import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Plan } from '@factorial/plan';

import { planSize } from './plan-size.ts';

const step = (i: number, files: string[]) => ({ id: `step-${i}`, description: `Change ${i}.`, files, verification: 'npm test' });

const plan = (steps: Plan['steps'], followUp?: string[]): Plan => ({
  schemaVersion: 1,
  summary: 'A change.',
  steps,
  tests: { run: [], add: [] },
  risks: [],
  openQuestions: [],
  ...(followUp ? { followUp } : {}),
});

describe('planSize', () => {
  it('counts steps, distinct files, description characters and follow-up items', () => {
    const size = planSize(plan([step(1, ['a.ts', 'b.ts']), step(2, ['b.ts', 'c.ts']), step(3, [])], ['Later.']));
    assert.deepEqual(size, { steps: 3, files: 3, descriptionChars: 27, followUp: 1 });
  });

  it('reports no follow-up when the plan has none', () => {
    assert.equal(planSize(plan([step(1, [])])).followUp, 0);
  });
});
