import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LiveChunks } from './live-chunks.ts';
import { ThrottledReport } from './live-publisher.ts';
import { ManualTimers, settle } from './live-test-timers.ts';

function chunks(put: (n: number, text: string) => Promise<void>) {
  const timers = new ManualTimers();
  const reports: Array<Record<string, unknown>> = [];
  const report = new ThrottledReport((_message, fields) => reports.push(fields), 'live chunk not stored', 60_000, () => timers.now);
  return { timers, reports, live: new LiveChunks({ put, report, timers }) };
}

const line = (seq: number) => `{"seq":${seq}}\n`;

describe('LiveChunks', () => {
  it('stores every 200 events, numbered from 1, each key once', async () => {
    const stored = new Map<number, string>();
    const { live } = chunks(async (n, text) => {
      assert.ok(!stored.has(n), `chunk ${n} written twice`);
      stored.set(n, text);
    });
    for (let seq = 1; seq <= 450; seq += 1) live.add(line(seq), seq);
    await settle();
    assert.deepEqual([...stored.keys()], [1, 2]);
    assert.equal(stored.get(1)?.split('\n').filter(Boolean).length, 200);
    assert.ok(stored.get(2)?.startsWith(line(201)));
    assert.deepEqual(await live.close(), { count: 3, lastSeq: 450, failed: 0 });
    assert.ok(stored.get(3)?.startsWith(line(401)));
    assert.ok(stored.get(3)?.endsWith(line(450)));
  });

  it('stores what has waited 30 seconds, whichever comes first', async () => {
    const stored: number[][] = [];
    const { live, timers } = chunks(async (_n, text) => {
      stored.push(text.trim().split('\n').map((l) => (JSON.parse(l) as { seq: number }).seq));
    });
    live.add(line(1), 1);
    live.add(line(2), 2);
    timers.advance(29_999);
    await settle();
    assert.equal(stored.length, 0);
    timers.advance(1);
    await settle();
    assert.deepEqual(stored, [[1, 2]]);
    // Nothing waiting, nothing stored.
    timers.advance(60_000);
    await settle();
    assert.equal(stored.length, 1);
    live.add(line(3), 3);
    await live.close();
    assert.deepEqual(stored, [[1, 2], [3]]);
  });

  it('counts a failed upload, moves on to the next number and never raises', async () => {
    const tried: number[] = [];
    const { live, reports } = chunks(async (n) => {
      tried.push(n);
      if (n === 1) throw new Error('AccessDenied');
    });
    for (let seq = 1; seq <= 400; seq += 1) live.add(line(seq), seq);
    assert.deepEqual(await live.close(), { count: 1, lastSeq: 400, failed: 1 });
    assert.deepEqual(tried, [1, 2]);
    assert.equal(reports[0]?.chunk, 1);
  });

  it('closes once and stores nothing after it', async () => {
    let puts = 0;
    const { live } = chunks(async () => {
      puts += 1;
    });
    assert.deepEqual(await live.close(), { count: 0, failed: 0 });
    live.add(line(1), 1);
    assert.deepEqual(await live.close(), { count: 0, failed: 0 });
    assert.equal(puts, 0);
  });
});
