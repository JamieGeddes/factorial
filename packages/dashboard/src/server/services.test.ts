import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { closeOnSignals } from './services.ts';

test('SIGINT and SIGTERM each close the live hub, once, and never exit the process', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const proc = new EventEmitter();
    let closed = 0;
    closeOnSignals({ close: () => (closed += 1) }, proc);
    assert.equal(proc.listenerCount('SIGINT'), 1);
    assert.equal(proc.listenerCount('SIGTERM'), 1);
    proc.emit(signal);
    assert.equal(closed, 1);
  }
});
