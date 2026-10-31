import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LivePublisher, ThrottledReport } from './live-publisher.ts';
import { ManualTimers, settle } from './live-test-timers.ts';

function publisher(send: ((channel: string, events: string[]) => Promise<{ failed: number }>) | undefined, maxQueue?: number) {
  const timers = new ManualTimers();
  const reports: Array<Record<string, unknown>> = [];
  const report = new ThrottledReport((_message, fields) => reports.push(fields), 'live publish failed', 60_000, () => timers.now);
  return { timers, reports, live: new LivePublisher({ channel: '/factorial/runs/x/build/1', send, report, timers, ...(maxQueue ? { maxQueue } : {}) }) };
}

describe('LivePublisher', () => {
  it('sends a full batch of five at once, and a partial one 250 ms after it started waiting', async () => {
    const batches: string[][] = [];
    const { live, timers } = publisher(async (_channel, events) => {
      batches.push(events);
      return { failed: 0 };
    });
    for (let i = 1; i <= 7; i += 1) live.add(`e${i}`);
    await settle();
    assert.deepEqual(batches, [['e1', 'e2', 'e3', 'e4', 'e5']]);
    timers.advance(249);
    await settle();
    assert.equal(batches.length, 1);
    timers.advance(1);
    await settle();
    assert.deepEqual(batches[1], ['e6', 'e7']);
    assert.equal(live.published, 7);
    assert.equal(live.dropped, 0);
  });

  it('keeps one request in flight, so events go out in order', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const { live } = publisher(async (_channel, events) => {
      order.push(...events);
      if (order.length === 5) await new Promise<void>((resolve) => (release = resolve));
      return { failed: 0 };
    });
    for (let i = 1; i <= 10; i += 1) live.add(`e${i}`);
    await settle();
    assert.equal(order.length, 5);
    release();
    await settle();
    await settle();
    assert.deepEqual(order, ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9', 'e10']);
  });

  it('counts a failed publish as dropped and reports it at most once a minute', async () => {
    const { live, timers, reports } = publisher(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    for (let i = 0; i < 10; i += 1) live.add('e');
    await settle();
    await settle();
    assert.equal(live.dropped, 10);
    assert.equal(live.published, 0);
    assert.equal(reports.length, 1);
    assert.match(String(reports[0]?.error), /ENOTFOUND/);
    timers.advance(60_000);
    for (let i = 0; i < 5; i += 1) live.add('e');
    await settle();
    assert.equal(reports.length, 2);
    assert.equal(reports[1]?.suppressed, 1);
  });

  it('counts events the service refused as dropped', async () => {
    const { live } = publisher(async () => ({ failed: 2 }));
    for (let i = 0; i < 5; i += 1) live.add('e');
    await settle();
    assert.equal(live.published, 3);
    assert.equal(live.dropped, 2);
  });

  it('drops every event when there is no endpoint, and never sends', async () => {
    const { live } = publisher(undefined);
    for (let i = 0; i < 12; i += 1) live.add('e');
    assert.deepEqual(await live.close(1000), { published: 0, dropped: 12 });
  });

  it('drops what would overfill the queue rather than holding it', async () => {
    const { live } = publisher(() => new Promise(() => {}), 6);
    for (let i = 0; i < 20; i += 1) live.add('e');
    await settle();
    // Five in flight, six waiting, nine dropped.
    assert.equal(live.dropped, 9);
  });

  it('sends what is waiting on close, and drops what is left after the timeout', async () => {
    const sent: string[] = [];
    const { live, timers } = publisher(async (_channel, events) => {
      sent.push(...events);
      return { failed: 0 };
    });
    live.add('a');
    live.add('b');
    assert.deepEqual(await live.close(1000), { published: 2, dropped: 0 });
    assert.deepEqual(sent, ['a', 'b']);
    live.add('late');
    assert.equal(live.dropped, 1);

    const stuck = publisher(() => new Promise(() => {}));
    stuck.live.add('x');
    const closing = stuck.live.close(1000);
    await settle();
    stuck.timers.advance(1000);
    // The one in flight when the wait ran out counts as dropped.
    assert.deepEqual(await closing, { published: 0, dropped: 1 });
    assert.equal(timers.size, 0);
  });
});
