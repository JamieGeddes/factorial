import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LedgerRow, RunEntry } from './records.ts';
import { buildRoundsLabel, runLine, runLineText } from './run-line.ts';

const run = (fields: RunEntry) => ({ run: fields });
const without = (key: keyof RunEntry): RunEntry => {
  const { [key]: _omitted, ...rest } = full;
  return rest;
};
const full: RunEntry = { runtimeName: 'pi', runtimeVersion: '0.4.1', turns: 12, toolCalls: 30, stopReason: 'end_turn', outcome: 'complete' };

test('a run with every field reads in the requested form', () => {
  const line = runLine(run(full));
  assert.ok(line);
  assert.equal(line.lead, 'pi v0.4.1 · 12 turns · 30 tool calls');
  assert.equal(line.stopped, 'stopped: end_turn');
  assert.equal(runLineText(line), 'pi v0.4.1 · 12 turns · 30 tool calls · stopped: end_turn');
});

test('parts the entry lacks are left out', () => {
  assert.equal(runLine(run(without('runtimeVersion')))?.lead, 'pi · 12 turns · 30 tool calls');
  assert.equal(runLine(run({ runtimeVersion: '1.2' }))?.lead, 'v1.2');
  assert.equal(runLine(run(without('turns')))?.lead, 'pi v0.4.1 · 30 tool calls');
  assert.equal(runLine(run(without('toolCalls')))?.lead, 'pi v0.4.1 · 12 turns');
  assert.equal(runLine(run(without('stopReason')))?.stopped, undefined);
  assert.equal(runLine(run({ turns: 0 }))?.lead, '0 turns');
  const onlyStop = runLine(run({ stopReason: 'x' }));
  assert.ok(onlyStop);
  assert.equal(runLineText(onlyStop), 'stopped: x');
  assert.equal(runLine({}), undefined);
  assert.equal(runLine(undefined), undefined);
  assert.equal(runLine(run({})), undefined);
  assert.equal(runLine(run({ outcome: 'failed' })), undefined);
});

test('control and bidirectional characters are removed and the line stays on one line', () => {
  const line = runLine(
    run({ runtimeName: 'p\u0000i\u202e', runtimeVersion: '1\u2066.0\u200f', turns: 1, stopReason: 'max\u001b[31m_tur\u0085ns\nsecond\tline\u202e' }),
  );
  assert.ok(line);
  assert.equal(line.lead, 'pi v1.0 · 1 turns');
  assert.equal(line.stopped, 'stopped: max[31m_turns second line');
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u200f\u202a-\u202e\u2066-\u2069]/.test(runLineText(line)));
});

test('non-string text is ignored', () => {
  const line = runLine({ run: { runtimeName: 5, stopReason: { a: 1 }, turns: 2 } as unknown as RunEntry });
  assert.equal(line?.lead, '2 turns');
  assert.equal(line?.stopped, undefined);
});

test('the outcome maps to the style of the stop reason', () => {
  assert.equal(runLine(run({ ...full, outcome: 'incomplete' }))?.tone, 'waiting');
  assert.equal(runLine(run({ ...full, outcome: 'failed' }))?.tone, 'failed');
  assert.equal(runLine(run({ ...full, outcome: 'complete' }))?.tone, 'plain');
  assert.equal(runLine(run(without('outcome')))?.tone, 'plain');
});

test('buildRoundsLabel counts Build#<n> keys and the older attribute', () => {
  const row = (fields: Partial<LedgerRow>): LedgerRow => ({ workItemId: 'x', ...fields });
  assert.equal(buildRoundsLabel(row({ stages: { Build: {}, 'Build#2': {}, Review: {} } })), '2 build rounds');
  assert.equal(buildRoundsLabel(row({ stages: { Build: {}, 'Build#2': {}, 'Build#3': {} } })), '3 build rounds');
  assert.equal(buildRoundsLabel(row({ stages: { Build: {}, Review: {} } })), undefined);
  assert.equal(buildRoundsLabel(row({})), undefined);
  assert.equal(buildRoundsLabel(row({ buildRounds: 3 })), '3 build rounds');
});
