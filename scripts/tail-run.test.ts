import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Printer, dataEvents, noticeLine, parseArgs, sanitise } from './tail-run.ts';

const id = '0e418ab8-1603-4ef7-90e1-ca78a0330833';
const at = '2026-10-31T12:00:05.000Z';

describe('parseArgs', () => {
  it('defaults to the first build round', () => {
    assert.deepEqual(parseArgs([id]), { workItemId: id, stage: 'build', round: 1 });
    assert.deepEqual(parseArgs([id, 'review']), { workItemId: id, stage: 'review', round: 1 });
    assert.deepEqual(parseArgs([id, 'build', '2']), { workItemId: id, stage: 'build', round: 2 });
  });

  it('refuses what is not an id, a stage or a round', () => {
    assert.throws(() => parseArgs([]), /usage/);
    assert.throws(() => parseArgs(['abc']), /usage/);
    assert.throws(() => parseArgs([id, '../x']), /not a stage/);
    assert.throws(() => parseArgs([id, 'build', '0']), /not a round/);
  });
});

describe('sanitise', () => {
  it('removes terminal escapes, control and bidirectional characters, and keeps newlines', () => {
    assert.equal(sanitise('a\u001b[2J\u001b]0;title\u0007b'), 'a[2J]0;titleb');
    assert.equal(sanitise('safe‮txt.exe'), 'safetxt.exe');
    assert.equal(sanitise('one\ntwo\tthree\r'), 'one\ntwo\tthree');
  });
});

describe('Printer', () => {
  it('prints each tool call on one line and a result only when it failed', () => {
    const printer = new Printer();
    assert.equal(printer.line({ seq: 3, at, event: { type: 'tool.call', callId: 'c', tool: 'bash', input: { cmd: 'npm test\nnpm run lint' } } }), '12:00:05     3  tool bash {"cmd":"npm test\\nnpm run lint"}');
    assert.equal(printer.line({ seq: 4, at, event: { type: 'tool.result', callId: 'c', content: 'all good' } }), undefined);
    assert.equal(printer.line({ seq: 5, at, event: { type: 'tool.result', callId: 'c', isError: true, content: 'exit 1\nfailed' } }), '12:00:05     5    ! exit 1 failed');
  });

  it('names the subagent an event came from', () => {
    const printer = new Printer();
    printer.line({ seq: 1, at, event: { type: 'subagent.started', agentId: 'call_plan', agentType: 'plan' } });
    assert.match(printer.line({ seq: 2, at, event: { type: 'text', agentId: 'call_plan', text: 'Plan written.' } }) ?? '', /\[plan\] Plan written\.$/);
  });

  it('says when the channel cut an event or left it out', () => {
    const printer = new Printer();
    assert.match(printer.line({ seq: 9, at, event: { type: 'text', text: 'start' }, truncated: true }) ?? '', /start \(cut\)$/);
    assert.match(printer.line({ seq: 10, at, event: { type: 'run.ended', omitted: true } }) ?? '', /run ended/);
    assert.match(printer.line({ seq: 11, at, event: { type: 'later.event', omitted: true } }) ?? '', /later\.event \(too large for the channel\)/);
  });

  it('prints the run end with its cost', () => {
    const printer = new Printer();
    assert.equal(
      printer.line({ seq: 284, at, event: { type: 'run.ended', outcome: 'complete', reason: 'completed', turns: 41, cost: { usd: 1.23456, basis: 'harness-estimate' } } }),
      '12:00:05   284  run ended: complete (completed), 41 turns, $1.2346',
    );
  });
});

describe('noticeLine', () => {
  it('prints a stage transition and the execution’s', () => {
    assert.equal(noticeLine({ stage: 'Build', round: 2, transition: 'started' }), '== Build round 2 started');
    assert.equal(noticeLine({ stage: 'WorkItem', transition: 'ended', status: 'pr-opened' }), '== WorkItem ended (pr-opened)');
    assert.equal(noticeLine({ eventId: 'x', workItemId: id, transition: 'succeeded' }), '== Execution succeeded');
    assert.equal(noticeLine({}), undefined);
  });
});

describe('dataEvents', () => {
  it('reads the events of a data message, singly or in a list', () => {
    assert.deepEqual(dataEvents({ event: ['{"a":1}', '{"b":2}'] }), [{ a: 1 }, { b: 2 }]);
    assert.deepEqual(dataEvents({ event: '{"a":1}' }), [{ a: 1 }]);
    assert.deepEqual(dataEvents({ event: 'not json' }), []);
    assert.deepEqual(dataEvents({}), []);
  });
});
