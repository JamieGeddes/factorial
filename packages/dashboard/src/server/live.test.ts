import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ManualTimers } from '../../test/timers.ts';
import { ID } from '../../test/stubs.ts';
import { LiveHub, parseChannel, type LiveMessage, type Upstream, type UpstreamHandlers } from './live.ts';

const RUN = `/factorial/runs/${ID}/build/1`;
const KEY = (n: number) => `${ID}/1/build/live/${String(n).padStart(4, '0')}.jsonl`;
const line = (seq: number, type = 'text') => JSON.stringify({ at: '2026-11-01T10:00:00.000Z', seq, type, text: `event ${seq}` });
const envelope = (seq: number, type = 'text') => ({ workItemId: ID, attempt: 1, role: 'builder', stage: 'build', round: 1, seq, at: '2026-11-01T10:00:00.000Z', event: { type, text: `event ${seq}` } });

class FakeUpstream implements Upstream {
  current: 'connected' = 'connected';
  channels = new Set<string>();
  adds = 0;
  readonly handlers: UpstreamHandlers;
  constructor(handlers: UpstreamHandlers) {
    this.handlers = handlers;
  }
  add(channel: string) {
    this.adds += 1;
    this.channels.add(channel);
  }
  remove(channel: string) {
    this.channels.delete(channel);
  }
}

function setup(chunks: Record<string, string> = {}, over = false) {
  const timers = new ManualTimers();
  let upstream: FakeUpstream | undefined;
  const hub = new LiveHub({
    upstream: (handlers) => (upstream = new FakeUpstream(handlers)),
    chunk: async (key) => chunks[key],
    attemptOf: async () => 1,
    runOver: async () => over,
    timers,
    firstPollMs: 1000,
    pollMs: 5000,
    graceMs: 10_000,
  });
  const tab = () => {
    const messages: LiveMessage[] = [];
    const ended = { count: 0 };
    const handle = hub.open({ send: (m) => messages.push(m), close: () => (ended.count += 1) });
    const seqs = () => messages.flatMap((m) => (m.kind === 'event' ? [m.envelope.seq] : []));
    return { messages, handle, seqs, ended };
  };
  return { timers, hub, tab, chunks, upstream: () => upstream as FakeUpstream };
}

test('joined part-way: chunks fill in what came before, live events wait their turn, each sent once in order', async () => {
  const { timers, tab, chunks, upstream } = setup({ [KEY(1)]: [1, 2, 3].map((n) => line(n)).join('\n') });
  const a = tab();
  a.handle.setChannels([RUN]);
  // Live events from 5 arrive before the chunks are read; 4 is in no chunk yet.
  upstream().handlers.onData(RUN, [envelope(5), envelope(6)]);
  assert.deepEqual(a.seqs(), []);
  await timers.advance(1000);
  assert.deepEqual(a.seqs(), [1, 2, 3]);
  chunks[KEY(2)] = [3, 4, 5].map((n) => line(n)).join('\n');
  await timers.advance(5000);
  assert.deepEqual(a.seqs(), [1, 2, 3, 4, 5, 6]);
  upstream().handlers.onData(RUN, [envelope(6), envelope(7, 'run.ended')]);
  assert.deepEqual(a.seqs(), [1, 2, 3, 4, 5, 6, 7]);
  await timers.advance(6000);
  const state = a.messages.filter((m) => m.kind === 'state').at(-1);
  assert.deepEqual(state?.kind === 'state' ? state.channels[RUN] : undefined, { events: 7, chunks: 2, ended: true });
});

test('two tabs on one run share one upstream subscription; the later tab gets the run from seq 1', async () => {
  const { timers, tab, upstream } = setup({ [KEY(1)]: [1, 2].map((n) => line(n)).join('\n') });
  const a = tab();
  a.handle.setChannels([RUN, '/factorial/work-items']);
  await timers.advance(1000);
  upstream().handlers.onData(RUN, [envelope(3)]);
  const b = tab();
  b.handle.setChannels([RUN]);
  assert.equal(upstream().adds, 2);
  assert.deepEqual(a.seqs(), [1, 2, 3]);
  assert.deepEqual(b.seqs(), [1, 2, 3]);
  upstream().handlers.onData(RUN, [envelope(4)]);
  assert.deepEqual(b.seqs(), [1, 2, 3, 4]);
});

test('a channel no tab wants is dropped after the grace period, unless a tab comes back', async () => {
  const { timers, tab, upstream } = setup();
  const a = tab();
  a.handle.setChannels(['/factorial/work-items']);
  a.handle.setChannels([]);
  await timers.advance(5000);
  a.handle.setChannels(['/factorial/work-items']);
  await timers.advance(20_000);
  assert.deepEqual([...upstream().channels], ['/factorial/work-items']);
  a.handle.close();
  await timers.advance(10_000);
  assert.deepEqual([...upstream().channels], []);
});

test('progress is relayed with repeats dropped by eventId', () => {
  const { tab, upstream } = setup();
  const a = tab();
  a.handle.setChannels(['/factorial/work-items']);
  const event = { eventId: 'e1', workItemId: ID, transition: 'started' };
  upstream().handlers.onData('/factorial/work-items', [event, event, { eventId: 'e2' }]);
  assert.equal(a.messages.filter((m) => m.kind === 'progress').length, 2);
});

test('a run whose item ended without its last event is marked incomplete after three quiet reads', async () => {
  const { timers, tab } = setup({ [KEY(1)]: line(1) }, true);
  const a = tab();
  a.handle.setChannels([RUN]);
  await timers.advance(1000 + 5000 * 4);
  const state = a.messages.filter((m) => m.kind === 'state').at(-1);
  assert.deepEqual(state?.kind === 'state' ? state.channels[RUN] : undefined, { events: 1, chunks: 1, incomplete: true });
});

test('a tab may ask only for the feed’s own channels', () => {
  assert.deepEqual(parseChannel(RUN), { kind: 'run', workItemId: ID, stage: 'build', round: 1 });
  assert.deepEqual(parseChannel(`/factorial/work-items/${ID}`), { kind: 'progress' });
  for (const bad of ['/factorial/runs/x/build/1', `/factorial/runs/${ID}/Build/1`, `/factorial/runs/${ID}/build/0`, '/other', `/factorial/runs/${ID}/build/1/x`, 7]) assert.equal(parseChannel(bad), undefined);
});

test('closing the hub ends every stream, removes every upstream channel and leaves no timer pending', async () => {
  const { timers, hub, tab, upstream } = setup();
  const a = tab();
  const b = tab();
  const c = tab();
  a.handle.setChannels([RUN, '/factorial/work-items']);
  b.handle.setChannels([RUN]);
  c.handle.setChannels(['/factorial/work-items']);
  await timers.advance(1000);
  // A channel in its grace period (drop timer) and a state flush (flush timer) are pending too.
  c.handle.setChannels([]);
  upstream().handlers.onData(RUN, [envelope(1)]);
  assert.ok(timers.pending > 0);
  assert.equal(hub.subscriptions, 2);
  const before = a.messages.length + b.messages.length + c.messages.length;

  hub.close();

  assert.deepEqual([a.ended.count, b.ended.count, c.ended.count], [1, 1, 1]);
  assert.deepEqual([...upstream().channels], []);
  assert.equal(hub.subscriptions, 0);
  assert.equal(timers.pending, 0);
  await timers.advance(60_000);
  assert.equal(timers.pending, 0);
  assert.equal(a.messages.length + b.messages.length + c.messages.length, before);

  hub.close();
  assert.deepEqual([a.ended.count, b.ended.count, c.ended.count], [1, 1, 1]);
});

test('after the hub is closed late work starts nothing: a poll in flight, upstream data, a new stream', async () => {
  const chunks: Record<string, string> = {};
  let release: (() => void) | undefined;
  const timers = new ManualTimers();
  let upstream: FakeUpstream | undefined;
  const hub = new LiveHub({
    upstream: (handlers) => (upstream = new FakeUpstream(handlers)),
    chunk: async (key) => {
      await new Promise<void>((resolve) => (release = resolve));
      return chunks[key];
    },
    attemptOf: async () => 1,
    runOver: async () => false,
    timers,
    firstPollMs: 1000,
  });
  const messages: LiveMessage[] = [];
  const handle = hub.open({ send: (m) => messages.push(m) });
  handle.setChannels([RUN]);
  await timers.advance(1000);
  hub.close();
  chunks[KEY(1)] = line(1);
  release?.();
  await timers.advance(60_000);
  assert.equal(timers.pending, 0);
  assert.deepEqual(messages.filter((m) => m.kind === 'event'), []);

  upstream?.handlers.onData(RUN, [envelope(2)]);
  upstream?.handlers.onState('connected');
  assert.equal(timers.pending, 0);

  let ended = 0;
  const late = hub.open({ send: () => assert.fail('nothing is sent after close'), close: () => (ended += 1) });
  assert.equal(ended, 1);
  assert.deepEqual(late.setChannels([RUN]), []);
  assert.equal(hub.subscriptions, 0);
  assert.equal(timers.pending, 0);
});

test('a stream that fails to end does not stop the others being ended', () => {
  const { hub } = setup();
  let ended = 0;
  hub.open({ send: () => {}, close: () => assert.fail('x') });
  hub.open({ send: () => {}, close: () => (ended += 1) });
  hub.close();
  assert.equal(ended, 1);
});
