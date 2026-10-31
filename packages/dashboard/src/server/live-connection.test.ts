import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ManualTimers, settle } from '../../test/timers.ts';
import { LiveConnection, backoffMs, type ConnectionState, type SocketLike } from './live-connection.ts';

class FakeSocket implements SocketLike {
  sent: Record<string, unknown>[] = [];
  closed = false;
  private readonly listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  readonly protocols: string[];
  constructor(protocols: string[]) {
    this.protocols = protocols;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
  }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown) {
    for (const l of this.listeners.get(type) ?? []) l({ data: data === undefined ? undefined : JSON.stringify(data) });
  }
}

function setup() {
  const timers = new ManualTimers();
  const sockets: FakeSocket[] = [];
  const data: [string, unknown[]][] = [];
  const states: ConnectionState[] = [];
  const resubscribed: string[] = [];
  const connection = new LiveConnection({
    url: async () => 'wss://x/event/realtime',
    socket: (_url, protocols) => {
      const socket = new FakeSocket(protocols);
      sockets.push(socket);
      return socket;
    },
    auth: { protocols: async () => ['aws-appsync-event-ws', 'header-x'], subscribe: async (channel) => ({ signed: channel }) },
    timers,
    onData: (channel, events) => data.push([channel, events]),
    onState: (state) => states.push(state),
    onResubscribed: (channel) => resubscribed.push(channel),
  });
  return { timers, sockets, data, states, resubscribed, connection };
}

const subscribes = (socket: FakeSocket) => socket.sent.filter((m) => m.type === 'subscribe').map((m) => m.channel);

test('one socket, one signed subscription per channel, data routed by subscription id', async () => {
  const { sockets, data, states, connection } = setup();
  connection.add('/factorial/work-items');
  connection.add('/factorial/work-items');
  await settle();
  assert.equal(sockets.length, 1);
  const socket = sockets[0] as FakeSocket;
  socket.emit('open');
  assert.deepEqual(socket.sent[0], { type: 'connection_init' });
  socket.emit('message', { type: 'connection_ack', connectionTimeoutMs: 300000 });
  await settle();
  connection.add('/factorial/runs/x');
  await settle();
  assert.deepEqual(subscribes(socket), ['/factorial/work-items', '/factorial/runs/x']);
  assert.deepEqual(socket.sent[1]?.authorization, { signed: '/factorial/work-items' });
  const id = socket.sent[1]?.id;
  socket.emit('message', { type: 'subscribe_success', id });
  socket.emit('message', { type: 'data', id, event: [JSON.stringify({ a: 1 }), 'not json'] });
  assert.deepEqual(data, [['/factorial/work-items', [{ a: 1 }]]]);
  assert.equal(states.at(-1), 'connected');
});

test('a lost connection reconnects with backoff and subscribes again to every channel', async () => {
  const { timers, sockets, states, resubscribed, connection } = setup();
  connection.add('/factorial/work-items');
  await settle();
  const first = sockets[0] as FakeSocket;
  first.emit('message', { type: 'connection_ack' });
  await settle();
  first.emit('message', { type: 'subscribe_success', id: first.sent.find((m) => m.type === 'subscribe')?.id });
  first.emit('close');
  assert.equal(states.at(-1), 'reconnecting');
  await timers.advance(backoffMs(1) - 1);
  assert.equal(sockets.length, 1);
  await timers.advance(1);
  assert.equal(sockets.length, 2);
  const second = sockets[1] as FakeSocket;
  second.emit('message', { type: 'connection_ack' });
  await settle();
  assert.deepEqual(subscribes(second), ['/factorial/work-items']);
  second.emit('message', { type: 'subscribe_success', id: second.sent.find((m) => m.type === 'subscribe')?.id });
  assert.deepEqual(resubscribed, ['/factorial/work-items']);
  assert.equal(states.at(-1), 'connected');
});

test('silence past the connection timeout counts as a lost connection', async () => {
  const { timers, sockets, connection } = setup();
  connection.add('/factorial/work-items');
  await settle();
  (sockets[0] as FakeSocket).emit('message', { type: 'connection_ack', connectionTimeoutMs: 10_000 });
  await timers.advance(10_000);
  assert.equal((sockets[0] as FakeSocket).closed, true);
  await timers.advance(backoffMs(1));
  assert.equal(sockets.length, 2);
});

test('removing the last channel unsubscribes and closes the socket', async () => {
  const { sockets, states, connection } = setup();
  connection.add('/factorial/work-items');
  await settle();
  const socket = sockets[0] as FakeSocket;
  socket.emit('message', { type: 'connection_ack' });
  await settle();
  const id = socket.sent.find((m) => m.type === 'subscribe')?.id;
  socket.emit('message', { type: 'subscribe_success', id });
  connection.remove('/factorial/work-items');
  assert.deepEqual(socket.sent.at(-1), { type: 'unsubscribe', id });
  assert.equal(socket.closed, true);
  assert.equal(states.at(-1), 'idle');
});

test('backoff doubles to a ceiling of 30 seconds', () => {
  assert.deepEqual([1, 2, 3, 6, 10].map(backoffMs), [1000, 2000, 4000, 30_000, 30_000]);
});
