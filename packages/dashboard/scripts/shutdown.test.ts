import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ManualTimers } from '../test/timers.ts';
import { GRACE_MS, createShutdown, type StopSignal } from './shutdown.ts';

function setup() {
  const timers = new ManualTimers();
  const calls: string[] = [];
  const shutdown = createShutdown({
    forward: (signal) => calls.push(`forward ${signal}`),
    kill: () => calls.push('kill'),
    exit: (code) => calls.push(`exit ${code}`),
    timers,
  });
  return { timers, calls, shutdown };
}

test('the grace period is 5 seconds', () => assert.equal(GRACE_MS, 5000));

for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]] as [StopSignal, number][]) {
  test(`one ${signal} is forwarded once; the server is killed 5 seconds later if still running`, async () => {
    const { timers, calls, shutdown } = setup();
    shutdown.signal(signal);
    assert.deepEqual(calls, [`forward ${signal}`]);
    await timers.advance(4999);
    assert.deepEqual(calls, [`forward ${signal}`]);
    await timers.advance(1);
    assert.deepEqual(calls, [`forward ${signal}`, 'kill', `exit ${code}`]);
    // The killed server's own exit changes nothing.
    shutdown.exited(null);
    await timers.advance(60_000);
    assert.equal(calls.length, 3);
  });
}

test('a server that exits within the grace period is not killed, and its code is kept', async () => {
  const { timers, calls, shutdown } = setup();
  shutdown.signal('SIGTERM');
  await timers.advance(1000);
  shutdown.exited(0);
  assert.deepEqual(calls, ['forward SIGTERM', 'exit 0']);
  assert.equal(timers.pending, 0);
  await timers.advance(60_000);
  assert.deepEqual(calls, ['forward SIGTERM', 'exit 0']);
});

test('a server that exits by the signal gives the signal’s code', () => {
  const { calls, shutdown } = setup();
  shutdown.signal('SIGINT');
  shutdown.exited(null);
  assert.deepEqual(calls, ['forward SIGINT', 'exit 130']);
});

test('a second signal kills at once, and later ones do nothing', async () => {
  const { timers, calls, shutdown } = setup();
  shutdown.signal('SIGINT');
  await timers.advance(1000);
  shutdown.signal('SIGINT');
  assert.deepEqual(calls, ['forward SIGINT', 'kill', 'exit 130']);
  assert.equal(timers.pending, 0);
  shutdown.signal('SIGTERM');
  shutdown.exited(null);
  await timers.advance(60_000);
  assert.equal(calls.length, 3);
});

test('a server that exits on its own gives its code, or 0', () => {
  const a = setup();
  a.shutdown.exited(3);
  assert.deepEqual(a.calls, ['exit 3']);
  const b = setup();
  b.shutdown.exited(null);
  assert.deepEqual(b.calls, ['exit 0']);
});
