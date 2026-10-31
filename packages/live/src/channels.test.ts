import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WORK_ITEMS_CHANNEL, runChannel, runsChannel, workItemChannel } from './channels.ts';

const id = '0e418ab8-1603-2ef7-10e1-ca78a0330833';

test('channels sit in the factorial namespace, a run at five segments', () => {
  assert.equal(WORK_ITEMS_CHANNEL, '/factorial/work-items');
  assert.equal(workItemChannel(id), `/factorial/work-items/${id}`);
  assert.equal(runChannel(id, 'build', 2), `/factorial/runs/${id}/build/2`);
  assert.equal(runChannel(id, 'review', 1).split('/').length - 1, 5);
  assert.equal(runsChannel(id), `/factorial/runs/${id}/*`);
});

test('a channel never takes a value that is not an id, a segment or a round', () => {
  assert.throws(() => workItemChannel('not-an-id'), /not a work item id/);
  assert.throws(() => runChannel(id, 'build/../x', 1), /not a channel segment/);
  assert.throws(() => runChannel(id, 'build', 0), /not a positive integer/);
});
