import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MemoryBus, MemoryLedger, ProgressRecorder, type LedgerRow } from '@factorial/progress';

import { stageError, stageOf, staged, stepError, type ProgressInput, type StagePolicy } from './progress.ts';

const ID = '84c2d660-d3ec-11f1-92c7-34ac6b750765';

function row(): LedgerRow {
  return {
    workItemId: ID,
    attempt: 1,
    status: 'accepted',
    workItem: {
      source: { type: 'github-issue', url: 'https://github.com/JamieGeddes/factorial/issues/15' },
      repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' },
    },
    stages: {},
  };
}

interface Input extends ProgressInput {
  id: string;
  fail?: boolean;
}

function harness<O>(policy: StagePolicy<Input, O>, body: (input: Input, start: () => Promise<void>) => Promise<O>, ledger = new MemoryLedger(row())) {
  const bus = new MemoryBus();
  const recorder = new ProgressRecorder(ledger, bus);
  const handler = staged<Input, O>(
    'test-stage',
    (input) => ({ workItemId: input.id }),
    policy,
    (input, _log, stage) => body(input, () => stage.start()),
    () => recorder,
  );
  const transitions = () => bus.events.map((e) => `${e.stage}${e.round ? `#${e.round}` : ''}:${e.transition}`);
  return { handler, ledger, bus, transitions };
}

const progress = (stage: string, round = 1) => ({ progress: { stage, round } });

test('the state machine names the stage; anything else records nothing', () => {
  assert.deepEqual(stageOf(progress('SaveWork', 2)), { stage: 'SaveWork', round: 2 });
  assert.equal(stageOf({}), undefined);
  assert.equal(stageOf({ progress: { stage: 'WorkItem' } }), undefined);
  assert.equal(stageOf({ progress: { stage: 'save-work' } }), undefined);
  assert.deepEqual(stageOf({ progress: { stage: 'Test', round: 0 } }), { stage: 'Test' });
});

test('a Step Functions error becomes a named, redacted error', () => {
  assert.deepEqual(stepError({ Error: 'States.TaskFailed', Cause: 'exit 3' }), { name: 'States.TaskFailed', message: 'exit 3' });
  assert.equal(stepError(null), undefined);
  assert.equal(stepError({ Cause: 'no name' }), undefined);
});

test('an input from an execution started before #15 runs unrecorded', async () => {
  const { handler, bus, ledger } = harness({}, async () => 'ok');
  assert.equal(await handler({ id: ID }), 'ok');
  assert.deepEqual(bus.events, []);
  assert.equal(ledger.writes, 0);
});

test('a stage starts when called and ends when the handler returns', async () => {
  const { handler, transitions, ledger } = harness({}, async () => 'ok');
  await handler({ id: ID, ...progress('Prepare') });
  assert.deepEqual(transitions(), ['Prepare:started', 'Prepare:succeeded']);
  assert.equal(ledger.row?.stages?.Prepare?.outcome, 'succeeded');
});

test('a handler that throws ends its stage failed and still throws', async () => {
  const { handler, transitions, ledger } = harness({}, async () => {
    throw Object.assign(new Error('clone failed'), { name: 'PrepareFailed' });
  });
  await assert.rejects(handler({ id: ID, ...progress('Prepare') }), /clone failed/);
  assert.deepEqual(transitions(), ['Prepare:started', 'Prepare:failed']);
  assert.deepEqual(ledger.row?.stages?.Prepare?.error, { name: 'PrepareFailed', message: 'clone failed' });
});

test('a stage that starts in the handler records nothing when it never starts', async () => {
  const duplicate = harness({ startsInHandler: true }, async () => {
    throw Object.assign(new Error('already accepted'), { name: 'DuplicateWorkItem' });
  });
  await assert.rejects(duplicate.handler({ id: ID, ...progress('Intake') }));
  assert.deepEqual(duplicate.transitions(), []);

  const accepted = harness({ startsInHandler: true }, async (_input, start) => {
    await start();
    return 'ok';
  });
  await accepted.handler({ id: ID, ...progress('Intake') });
  assert.deepEqual(accepted.transitions(), ['Intake:started', 'Intake:succeeded']);
});

test('a stage that ends later stays open on success but ends on a failure', async () => {
  const dispatched = harness({ endsLater: true }, async () => undefined);
  await dispatched.handler({ id: ID, ...progress('Test') });
  assert.deepEqual(dispatched.transitions(), ['Test:started']);

  const failed = harness({ endsLater: true }, async () => {
    throw new Error('dispatch refused');
  });
  await assert.rejects(failed.handler({ id: ID, ...progress('Test') }));
  assert.deepEqual(failed.transitions(), ['Test:started', 'Test:failed']);
});

test('a stage closes earlier ones in its round before it starts, without overwriting a recorded end', async () => {
  const ledger = new MemoryLedger(row());
  const saveWork = harness<string>(
    { closes: () => [{ stage: 'Build', outcome: 'failed', error: stageError('States.TaskFailed') }] },
    async () => 'saved',
    ledger,
  );
  await saveWork.handler({ id: ID, ...progress('SaveWork', 2) });
  assert.deepEqual(saveWork.transitions(), ['Build#2:failed', 'SaveWork#2:started', 'SaveWork#2:succeeded']);
  assert.equal(ledger.row?.stages?.['Build#2']?.error?.name, 'States.TaskFailed');

  ledger.row!.stages!.Review = { startedAt: 'earlier', endedAt: 'earlier', outcome: 'succeeded' };
  const collectReview = harness<string>({ closes: () => [{ stage: 'Review', outcome: 'failed' }] }, async () => 'ok', ledger);
  await collectReview.handler({ id: ID, ...progress('CollectReview') });
  assert.equal(ledger.row?.stages?.Review?.outcome, 'succeeded');
  assert.deepEqual(collectReview.transitions(), ['CollectReview:started', 'CollectReview:succeeded'], 'nothing new to say about Review');
});

test('a terminal stage ends the work item after its own end, closing what is left open', async () => {
  const ledger = new MemoryLedger(row());
  ledger.row!.stages!.Test = { startedAt: '2026-10-30T22:00:00.000Z' };
  ledger.row!.status = 'failed';
  const report = harness<void>({ ends: () => true, failure: () => stageError('States.Timeout') }, async () => undefined, ledger);
  await report.handler({ id: ID, ...progress('ReportFailure') });
  assert.deepEqual(report.transitions(), ['ReportFailure:started', 'ReportFailure:succeeded', 'Test:failed', 'WorkItem:ended']);
  assert.equal(ledger.row?.stages?.Test?.error?.name, 'States.Timeout');
  assert.equal(report.bus.events.at(-1)?.status, 'failed');
});

test('a stage that ends the work item only on success leaves a failure to the next state', async () => {
  const failing = harness<string>({ ends: (_input, result) => result !== undefined }, async () => {
    throw new Error('GitHub refused');
  });
  await assert.rejects(failing.handler({ id: ID, ...progress('OpenPullRequest') }));
  assert.deepEqual(failing.transitions(), ['OpenPullRequest:started', 'OpenPullRequest:failed']);

  const report = harness<void>({ ends: () => true }, async () => {
    throw new Error('comment failed');
  });
  await assert.rejects(report.handler({ id: ID, ...progress('ReportFailure') }));
  assert.deepEqual(report.transitions(), ['ReportFailure:started', 'ReportFailure:failed', 'WorkItem:ended']);
});
