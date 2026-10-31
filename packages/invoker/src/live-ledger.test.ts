import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LiveLedger, liveSnapshot, type LiveSnapshot } from './live-ledger.ts';
import { ThrottledReport } from './live-publisher.ts';
import { ManualTimers, settle } from './live-test-timers.ts';
import { RunTally } from './run-events.ts';

const started = { type: 'run.started', contract: 1, harness: { name: 'pi' }, role: 'builder', models: [{ purpose: 'main', id: 'm' }] };
const call = (input: number, usd?: number) => ({ type: 'model.call', usage: { inputTokens: input, outputTokens: 10 }, ...(usd !== undefined ? { cost: { usd } } : {}) });

function snapshot(tally: RunTally, ended = false) {
  return liveSnapshot({
    role: 'builder',
    stage: 'build',
    round: 1,
    now: new Date('2026-10-31T12:01:30.000Z'),
    startedAt: Date.parse('2026-10-31T12:00:00.000Z'),
    seq: 9,
    events: 9,
    lastEvent: { type: 'tool.call', at: '2026-10-31T12:01:29.000Z' },
    tally,
    version: { maxTurns: 150, maxBudgetUsd: 10, maxDurationSeconds: 3600, modelId: 'm' },
    ended,
  });
}

describe('liveSnapshot', () => {
  it('mid-run: the summed calls, their cost estimates, no turns, and the limits', () => {
    const tally = new RunTally();
    for (const event of [started, call(100, 0.001), call(200, 0.002), { type: 'tool.call', callId: 'c', tool: 'read', input: {} }]) tally.add(event);
    const live = snapshot(tally);
    assert.equal(live.modelCalls, 2);
    assert.equal(live.usage.inputTokens, 300);
    assert.equal(live.costUsd, 0.003);
    assert.equal(live.turns, undefined);
    assert.equal(live.toolCalls, 1);
    assert.equal(live.elapsedSeconds, 90);
    assert.deepEqual(live.limits, { maxTurns: 150, maxBudgetUsd: 10, maxDurationSeconds: 3600 });
    assert.equal(live.ended, undefined);
  });

  it('before any host sends a per-call cost, shows none', () => {
    const tally = new RunTally();
    for (const event of [started, call(100)]) tally.add(event);
    assert.equal(snapshot(tally).costUsd, undefined);
  });

  it("after run.ended: the harness's turns and cost, and the run's totals", () => {
    const tally = new RunTally();
    for (const event of [
      started,
      call(100, 0.001),
      {
        type: 'run.ended',
        outcome: 'complete',
        reason: 'completed',
        turns: 4,
        cost: { usd: 0.012345678, basis: 'harness-estimate' },
        models: [{ model: { id: 'm' }, usage: { inputTokens: 150, outputTokens: 30 } }],
      },
    ])
      tally.add(event);
    const live = snapshot(tally, true);
    assert.equal(live.turns, 4);
    assert.equal(live.costUsd, 0.0123);
    assert.equal(live.usage.inputTokens, 150);
    assert.equal(live.usage.outputTokens, 30);
    assert.equal(live.ended, true);
  });
});

describe('LiveLedger', () => {
  it('writes every minute, when asked, and a final snapshot on stop, one at a time', async () => {
    const timers = new ManualTimers();
    const writes: Array<{ ended: boolean }> = [];
    const ledger = new LiveLedger({
      write: async (live: LiveSnapshot) => {
        writes.push({ ended: live.ended === true });
      },
      snapshot: (ended) => ({ ended: ended ? true : undefined }) as unknown as LiveSnapshot,
      report: new ThrottledReport(() => {}, 'x'),
      timers,
    });
    ledger.start();
    ledger.now();
    await settle();
    assert.equal(writes.length, 1);
    timers.advance(60_000);
    await settle();
    timers.advance(60_000);
    await settle();
    assert.equal(writes.length, 3);
    await ledger.stop();
    assert.deepEqual(writes.at(-1), { ended: true });
    assert.equal(timers.size, 0);
    ledger.now();
    await settle();
    assert.equal(writes.length, 4);
  });

  it('reports a failed write and carries on', async () => {
    const reports: unknown[] = [];
    let calls = 0;
    const ledger = new LiveLedger({
      write: async () => {
        calls += 1;
        if (calls === 1) throw new Error('ConditionalCheckFailed');
      },
      snapshot: () => ({}) as LiveSnapshot,
      report: new ThrottledReport((_m, fields) => reports.push(fields), 'live progress not recorded', 0),
      timers: new ManualTimers(),
    });
    ledger.now();
    await ledger.stop();
    assert.equal(calls, 2);
    assert.equal(ledger.failures, 1);
    assert.equal(ledger.writes, 1);
    assert.equal(reports.length, 1);
  });
});
