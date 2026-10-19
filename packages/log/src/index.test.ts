import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger, logLine } from './index.ts';

const ID = '0b6f4a8e-6d3c-4a51-9c1e-2f7d8b9a0c1d';

test('a line carries the run key, stage, level and message first, then the fields', () => {
  const line = logLine('collect', { workItemId: ID, attempt: 2 }, 'info', 'pushed', { headSha: 'abc' });
  assert.equal(line, `{"workItemId":"${ID}","attempt":2,"stage":"collect","level":"info","message":"pushed","headSha":"abc"}`);
});

test('fields cannot replace the run key or the stage', () => {
  const parsed = JSON.parse(
    logLine('build', { workItemId: ID, attempt: 1 }, 'info', 'm', { workItemId: 'other', attempt: 9, stage: 'x', message: 'y' }),
  );
  assert.equal(parsed.workItemId, ID);
  assert.equal(parsed.attempt, 1);
  assert.equal(parsed.stage, 'build');
  assert.equal(parsed.message, 'm');
});

test('an unknown key is left out rather than written as null', () => {
  const parsed = JSON.parse(logLine('report', {}, 'error', 'no work item'));
  assert.deepEqual(Object.keys(parsed), ['stage', 'level', 'message']);
});

test('errors are written as name and message', () => {
  const parsed = JSON.parse(logLine('prepare', { workItemId: ID }, 'error', 'failed', { error: new TypeError('bad input') }));
  assert.equal(parsed.error, 'TypeError: bad input');
});

test('lines are redacted', () => {
  const line = logLine('collect', { workItemId: ID }, 'error', 'push failed', {
    error: new Error('fatal: https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r'),
  });
  assert.ok(!line.includes('ghs_abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.ok(line.includes('x-access-token:***@'));
});

test('with sets the run key once it is known, keeping the stage', () => {
  const lines: string[] = [];
  const early = createLogger('prepare', {}, (line) => lines.push(line));
  early.info('accepting');
  early.with({ workItemId: ID }).with({ attempt: 3 }).info('accepted', { branch: 'factorial/x' });
  assert.deepEqual(
    lines.map((line) => JSON.parse(line)),
    [
      { stage: 'prepare', level: 'info', message: 'accepting' },
      { workItemId: ID, attempt: 3, stage: 'prepare', level: 'info', message: 'accepted', branch: 'factorial/x' },
    ],
  );
});
