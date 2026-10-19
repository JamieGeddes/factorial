import assert from 'node:assert/strict';
import { test } from 'node:test';

import { logged, unvalidatedId } from './log.ts';

const ID = '0b6f4a8e-6d3c-4a51-9c1e-2f7d8b9a0c1d';

test('a failing handler logs the failure with the run key, then rethrows', async () => {
  const lines: string[] = [];
  const handler = logged(
    'collect',
    (input: { id: string }) => ({ workItemId: input.id, attempt: 2 }),
    async () => {
      throw new Error('push rejected');
    },
    (line) => lines.push(line),
  );
  await assert.rejects(handler({ id: ID }), /push rejected/);
  assert.deepEqual(JSON.parse(lines[0] ?? ''), {
    workItemId: ID,
    attempt: 2,
    stage: 'collect',
    level: 'error',
    message: 'failed',
    error: 'Error: push rejected',
  });
});

test('the handler logs through a logger carrying the run key', async () => {
  const lines: string[] = [];
  const handler = logged(
    'dispatch-tests',
    () => ({ workItemId: ID, attempt: 1 }),
    async (_input: unknown, log) => {
      log.info('dispatched');
      return 'ok';
    },
    (line) => lines.push(line),
  );
  assert.equal(await handler({}), 'ok');
  assert.equal(JSON.parse(lines[0] ?? '').workItemId, ID);
});

test('an input whose key cannot be read is still handled', async () => {
  const handler = logged(
    'report',
    (input: { ctx: { workItem: { id: string } } }) => ({ workItemId: input.ctx.workItem.id }),
    async () => 'handled',
    () => {},
  );
  assert.equal(await handler({} as never), 'handled');
});

test('unvalidatedId reads only a string id', () => {
  assert.equal(unvalidatedId({ id: ID }), ID);
  assert.equal(unvalidatedId({ id: 7 }), undefined);
  assert.equal(unvalidatedId(null), undefined);
  assert.equal(unvalidatedId('text'), undefined);
});
