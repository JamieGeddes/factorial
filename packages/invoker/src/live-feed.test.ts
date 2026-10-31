import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseEnvelope } from '@factorial/live';

import { LiveFeed, type FeedState } from './live-feed.ts';
import type { LiveSnapshot } from './live-ledger.ts';
import { ManualTimers, settle } from './live-test-timers.ts';

const context = { workItemId: '0e418ab8-1603-2ef7-10e1-ca78a0330833', attempt: 1, role: 'builder', stage: 'build', round: 1 };
const at = new Date('2026-10-31T12:00:00.000Z');

function feed(options: { send?: boolean; failSend?: boolean; chunks?: boolean } = {}) {
  const published: string[] = [];
  const chunks = new Map<number, string>();
  const snapshots: Array<{ state: FeedState; ended: boolean }> = [];
  const reports: string[] = [];
  const timers = new ManualTimers();
  const live = new LiveFeed({
    context,
    channel: '/factorial/runs/0e418ab8-1603-2ef7-10e1-ca78a0330833/build/1',
    send:
      options.send === false
        ? undefined
        : async (_channel, events) => {
            if (options.failSend) throw new Error('getaddrinfo ENOTFOUND');
            published.push(...events);
            return { failed: 0 };
          },
    putChunk: options.chunks === false ? undefined : async (n, text) => void chunks.set(n, text),
    writeLive: async () => {},
    snapshot: (state, ended) => {
      snapshots.push({ state, ended });
      return {} as LiveSnapshot;
    },
    report: (message) => reports.push(message),
    timers,
    now: () => timers.now,
  });
  return { live, published, chunks, snapshots, reports, timers };
}

describe('LiveFeed', () => {
  it('publishes each event, chunks its transcript line, and records progress at the start and end', async () => {
    const { live, published, chunks, snapshots } = feed();
    live.event({ type: 'run.started' }, 1, at, '{"seq":1}\n');
    live.event({ type: 'text', text: 'hi' }, 2, at, '{"seq":2}\n');
    live.event({ type: 'run.ended' }, 3, at, '{"seq":3}\n');
    const record = await live.close();
    assert.deepEqual(
      published.map((text) => parseEnvelope(text)?.seq),
      [1, 2, 3],
    );
    assert.equal(chunks.get(1), '{"seq":1}\n{"seq":2}\n{"seq":3}\n');
    assert.deepEqual(record, { published: 3, dropped: 0, chunks: { count: 1, lastSeq: 3, failed: 0 } });
    // run.started, run.ended and the final snapshot.
    assert.deepEqual(
      snapshots.map((s) => [s.state.seq, s.ended]),
      [
        [1, false],
        [3, false],
        [3, true],
      ],
    );
    assert.deepEqual(snapshots[2]?.state.lastEvent, { type: 'run.ended', at: '2026-10-31T12:00:00.000Z' });
  });

  it('with the API gone, drops every event, still chunks, and reports once', async () => {
    const { live, chunks, reports } = feed({ failSend: true });
    for (let seq = 1; seq <= 12; seq += 1) live.event({ type: 'text', text: 'x' }, seq, at, `{"seq":${seq}}\n`);
    await settle();
    const record = await live.close();
    assert.equal(record.dropped, 12);
    assert.equal(record.published, 0);
    assert.equal(chunks.size, 1);
    assert.deepEqual(reports, ['live publish failed']);
  });

  it('chunks only the lines the transcript kept', async () => {
    const { live, chunks } = feed();
    live.event({ type: 'text', text: 'kept' }, 1, at, '{"seq":1}\n');
    live.event({ type: 'text', text: 'past the cap' }, 2, at, undefined);
    assert.deepEqual((await live.close()).chunks, { count: 1, lastSeq: 1, failed: 0 });
    assert.equal(chunks.get(1), '{"seq":1}\n');
  });

  it('without an endpoint or a prefix, counts every event dropped and stores no chunk', async () => {
    const { live } = feed({ send: false, chunks: false });
    live.event({ type: 'run.started' }, 1, at, '{"seq":1}\n');
    assert.deepEqual(await live.close(), { published: 0, dropped: 1, chunks: { count: 0, failed: 0 } });
  });

  it('closes once', async () => {
    const { live } = feed();
    assert.equal(live.close(), live.close());
  });
});
