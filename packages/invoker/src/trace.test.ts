import assert from 'node:assert/strict';
import { test } from 'node:test';

import { traceBaggage } from './trace.ts';

const ID = '0b6f4a8e-6d3c-4a51-9c1e-2f7d8b9a0c1d';

test('baggage carries the session id, work item id and attempt', () => {
  assert.equal(traceBaggage(ID, ID, 2), `session.id=${ID},factorial.workItemId=${ID},factorial.attempt=2`);
});

test('an unknown attempt is left out', () => {
  assert.equal(traceBaggage(ID, ID, undefined), `session.id=${ID},factorial.workItemId=${ID}`);
});

test('values are percent-encoded', () => {
  assert.equal(traceBaggage('a,b=c', ID, 1).split(',')[0], 'session.id=a%2Cb%3Dc');
});
