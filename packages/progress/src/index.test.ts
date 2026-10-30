import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MemoryBus,
  MemoryLedger,
  ProgressRecorder,
  isStageName,
  parseStageKey,
  progressEvent,
  progressEventErrors,
  stageError,
  stageKey,
  updateFor,
  type Ledger,
  type LedgerRow,
} from './index.ts';

const ID = '84c2d660-d3ec-11f1-92c7-34ac6b750765';

function newRow(): LedgerRow {
  return {
    workItemId: ID,
    attempt: 1,
    threadKey: 'jamiegeddes/factorial#factorial/84c2d660',
    status: 'accepted',
    workItem: {
      source: { type: 'github-issue', url: 'https://github.com/JamieGeddes/factorial/issues/15' },
      repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' },
    },
    stages: {},
  };
}

class FakeLedger extends MemoryLedger {
  constructor() {
    super(newRow());
  }
}

class FakeBus extends MemoryBus {}

function recorder(ledger: Ledger = new FakeLedger()) {
  let tick = 0;
  const bus = new FakeBus();
  const errors: Array<{ message: string; fields: Record<string, unknown> }> = [];
  const r = new ProgressRecorder(ledger, bus, {
    now: () => `2026-10-30T22:00:${String(tick++).padStart(2, '0')}.000Z`,
    onError: (message, fields) => errors.push({ message, fields }),
  });
  return { r, bus, errors };
}

test('stage keys carry the round only for round stages after the first', () => {
  assert.equal(stageKey('Build'), 'Build');
  assert.equal(stageKey('Build', 1), 'Build');
  assert.equal(stageKey('Build', 2), 'Build#2');
  assert.equal(stageKey('SaveWork', 3), 'SaveWork#3');
  assert.equal(stageKey('Test', 2), 'Test');
  assert.deepEqual(parseStageKey('ContinueBuild#2'), { stage: 'ContinueBuild', round: 2 });
  assert.deepEqual(parseStageKey('Review'), { stage: 'Review' });
});

test('a stage name is a state name, never the work item', () => {
  assert.ok(isStageName('PrepareReview'));
  assert.ok(!isStageName('WorkItem'));
  assert.ok(!isStageName('build'));
  assert.ok(!isStageName('Build#2'));
  assert.ok(!isStageName(undefined));
});

test('a started and ended stage is recorded once each and announced', async () => {
  const ledger = new FakeLedger();
  const { r, bus, errors } = recorder(ledger);
  await r.started(ID, 'Prepare');
  await r.ended(ID, 'Prepare', undefined, 'succeeded');
  assert.deepEqual(errors, []);
  assert.deepEqual(ledger.row?.stages?.Prepare, { startedAt: '2026-10-30T22:00:00.000Z', endedAt: '2026-10-30T22:00:01.000Z', outcome: 'succeeded' });
  assert.deepEqual(
    bus.events.map((e) => [e.eventId, e.transition, e.at]),
    [
      [`${ID}:Prepare:started`, 'started', '2026-10-30T22:00:00.000Z'],
      [`${ID}:Prepare:succeeded`, 'succeeded', '2026-10-30T22:00:01.000Z'],
    ],
  );
  for (const event of bus.events) assert.deepEqual(progressEventErrors(event), []);
});

test('a retried transition writes nothing and repeats the same event', async () => {
  const ledger = new FakeLedger();
  const { r, bus } = recorder(ledger);
  await r.started(ID, 'Build', 2);
  await r.started(ID, 'Build', 2);
  await r.ended(ID, 'Build', 2, 'failed', { error: stageError('max_turns', 'the builder reached its turn limit') });
  await r.ended(ID, 'Build', 2, 'failed', { error: stageError('other', 'a later copy') });
  assert.equal(ledger.writes, 2);
  assert.equal(bus.events.length, 4);
  assert.deepEqual(bus.events[0], bus.events[1]);
  assert.deepEqual(bus.events[2], bus.events[3]);
  assert.equal(bus.events[2]?.error?.name, 'max_turns');
  assert.equal(bus.events[2]?.round, 2);
  assert.equal(ledger.row?.stages?.['Build#2']?.round, 2);
});

test('ending a stage that never recorded its start records its end alone', async () => {
  const ledger = new FakeLedger();
  const { r, bus } = recorder(ledger);
  await r.ended(ID, 'Build', 1, 'failed', { error: stageError('States.TaskFailed') });
  assert.deepEqual(ledger.row?.stages?.Build, { endedAt: '2026-10-30T22:00:00.000Z', outcome: 'failed', error: { name: 'States.TaskFailed' } });
  assert.equal(bus.events[0]?.transition, 'failed');
});

test('no row means nothing is written or announced', async () => {
  const ledger = new MemoryLedger();
  const { r, bus, errors } = recorder(ledger);
  await r.started(ID, 'Intake');
  await r.ended(ID, 'Intake', undefined, 'failed');
  await r.workItemEnded(ID);
  assert.deepEqual(bus.events, []);
  assert.deepEqual(errors, []);
});

test('the work item ends once, closing any stage left open', async () => {
  const ledger = new FakeLedger();
  const { r, bus } = recorder(ledger);
  await r.started(ID, 'Test');
  ledger.row!.status = 'tests-failed';
  await r.workItemEnded(ID, stageError('TestsFailed', 'The change did not pass the repository checks.'));
  await r.workItemEnded(ID);
  assert.equal(ledger.row?.stages?.Test?.outcome, 'failed');
  assert.equal(ledger.row?.stages?.Test?.error?.name, 'TestsFailed');
  assert.deepEqual(
    bus.events.map((e) => [e.stage, e.transition, e.status]),
    [
      ['Test', 'started', undefined],
      ['Test', 'failed', undefined],
      ['WorkItem', 'ended', 'tests-failed'],
      ['WorkItem', 'ended', 'tests-failed'],
    ],
  );
  assert.deepEqual(bus.events[2], bus.events[3]);
  assert.deepEqual(progressEventErrors(bus.events[2]), []);
});

test('a failing ledger or bus is reported, never raised', async () => {
  const failing: Ledger = { apply: () => Promise.reject(new Error('throttled')) };
  const { r, errors } = recorder(failing);
  await r.started(ID, 'Collect');
  assert.equal(await r.ended(ID, 'Collect', undefined, 'succeeded'), undefined);
  await r.workItemEnded(ID);
  assert.deepEqual(
    errors.map((e) => e.message),
    ['progress not recorded', 'progress not recorded', 'progress not recorded'],
  );

  const ledger = new FakeLedger();
  const errorsFromBus: string[] = [];
  const withBadBus = new ProgressRecorder(ledger, { put: () => Promise.reject(new Error('bus down')) }, { onError: (m) => errorsFromBus.push(m) });
  await withBadBus.started(ID, 'Collect');
  assert.ok(ledger.row?.stages?.Collect?.startedAt, 'the ledger write stands');
  assert.deepEqual(errorsFromBus, ['progress not recorded']);
});

test('a row without a readable WorkItem records the stage but announces nothing', async () => {
  const row = newRow();
  delete row.workItem;
  const ledger = new MemoryLedger(row);
  const { r, bus, errors } = recorder(ledger);
  await r.started(ID, 'Prepare');
  assert.ok(ledger.row?.stages?.Prepare?.startedAt);
  assert.deepEqual(bus.events, []);
  assert.equal(errors[0]?.message, 'progress event not built');
});

test('an agent run is carried on its stage end', async () => {
  const ledger = new FakeLedger();
  const { r, bus } = recorder(ledger);
  const run = {
    role: 'reviewer',
    runtimeName: 'factorial_reviewer',
    runtimeVersion: '20',
    runContract: 1,
    harness: { name: 'pi', version: '1.4.0' },
    modelId: 'global.anthropic.claude-sonnet-5-5',
    effort: 'high',
    sessionId: ID,
    toolCalls: 8,
    turns: 10,
    durationSeconds: 74,
    stopReason: 'completed',
    outcome: 'complete' as const,
    usage: { modelCalls: 10, inputTokens: 120000, outputTokens: 3000, cacheReadInputTokens: 90000 },
    costUsd: 0.42,
    transcriptKey: `${ID}/1/review/transcript.jsonl`,
    usageKey: `${ID}/1/review/usage.json`,
  };
  await r.started(ID, 'Review');
  await r.ended(ID, 'Review', undefined, 'succeeded', { run });
  assert.deepEqual(ledger.row?.stages?.Review?.run, run);
  assert.deepEqual(bus.events[1]?.run, run);
  assert.deepEqual(progressEventErrors(bus.events[1]), []);
});

test('errors are redacted and capped', () => {
  const error = stageError('Error', `token ghs_${'a'.repeat(36)} ${'x'.repeat(2000)}`);
  assert.ok(!error.message?.includes('ghs_aaaa'));
  assert.equal(error.message?.length, 1000);
});

test('the schema refuses an event out of shape', () => {
  const event = progressEvent(newRow(), 'Prepare', 'started', '2026-10-30T22:00:00.000Z');
  assert.ok(event);
  assert.deepEqual(progressEventErrors(event), []);
  assert.notDeepEqual(progressEventErrors({ ...event, transition: 'ended' }), [], 'ended is only for the work item');
  assert.notDeepEqual(progressEventErrors({ ...event, stage: 'WorkItem' }), [], 'the work item only ends');
  assert.notDeepEqual(progressEventErrors({ ...event, error: { name: 'x' } }), [], 'a start has no error');
  assert.notDeepEqual(progressEventErrors({ ...event, body: 'content' }), [], 'no other fields');
});

test('the updates require the row, and never overwrite a recorded transition', () => {
  const put = updateFor('t', ID, { kind: 'put', key: 'Build#2', entry: { round: 2, startedAt: 'now' } });
  assert.equal(put.ConditionExpression, 'attribute_exists(workItemId) AND attribute_not_exists(#stages.#key)');
  assert.equal(put.ExpressionAttributeNames?.['#key'], 'Build#2');
  const end = updateFor('t', ID, { kind: 'end', key: 'Build', fields: { endedAt: 'now', outcome: 'failed', error: { name: 'x' } } });
  assert.equal(end.UpdateExpression, 'SET #stages.#key.#endedAt = :endedAt, #stages.#key.#outcome = :outcome, #stages.#key.#error = :error');
  assert.equal(end.ConditionExpression, 'attribute_exists(#stages.#key) AND attribute_not_exists(#stages.#key.#endedAt)');
  const ended = updateFor('t', ID, { kind: 'work-item-end', at: 'now' });
  assert.equal(ended.ConditionExpression, 'attribute_exists(workItemId) AND attribute_not_exists(#endedAt)');
  for (const update of [put, end, ended]) assert.equal(update.ReturnValuesOnConditionCheckFailure, 'ALL_OLD');
});

test('every example in the contract fits it', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const folder = new URL('../../../contracts/progress/v1/examples/', import.meta.url);
  const files = readdirSync(folder).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 3);
  for (const name of files) {
    assert.deepEqual(progressEventErrors(JSON.parse(readFileSync(new URL(name, folder), 'utf8'))), [], name);
  }
});
