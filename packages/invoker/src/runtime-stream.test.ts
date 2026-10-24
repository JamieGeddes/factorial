import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSse, streamRun, type InvokeSession } from './runtime-stream.ts';

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield new TextEncoder().encode(part);
}

const sse = (id: number, data: unknown) => `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

describe('parseSse', () => {
  it('reads numbered JSON events split across chunks', async () => {
    const text = sse(1, { type: 'system' }) + sse(2, { type: 'result', subtype: 'success' });
    const events = await collect(parseSse(chunks(text.slice(0, 7), text.slice(7, 30), text.slice(30))));
    assert.deepEqual(events, [
      { id: 1, data: { type: 'system' } },
      { id: 2, data: { type: 'result', subtype: 'success' } },
    ]);
  });

  it('accepts CRLF line endings and a final event without a blank line', async () => {
    const events = await collect(parseSse(chunks('id: 4\r\ndata: {"a":1}\r\n\r\nid: 5\ndata: {"b":2}')));
    assert.deepEqual(events, [
      { id: 4, data: { a: 1 } },
      { id: 5, data: { b: 2 } },
    ]);
  });
});

describe('streamRun', () => {
  const options = { maxReconnects: 3, delayMs: 0, sleep: async () => {} };
  const ended = (messages: unknown[]) => () => messages.some((m) => (m as { type?: string }).type === 'result');

  it('delivers a whole run from one stream', async () => {
    const payloads: object[] = [];
    const invoke: InvokeSession = async (payload) => {
      payloads.push(payload);
      return chunks(sse(1, { type: 'system' }), sse(2, { type: 'result' }));
    };
    const messages: unknown[] = [];
    const reconnects = await streamRun(invoke, { action: 'run' }, (m) => messages.push(m), ended(messages), options);
    assert.equal(reconnects, 0);
    assert.deepEqual(messages, [{ type: 'system' }, { type: 'result' }]);
    assert.deepEqual(payloads, [{ action: 'run' }]);
  });

  it('re-attaches after the last message it has when a stream ends early, without repeats', async () => {
    const payloads: object[] = [];
    const streams = [
      () => chunks(sse(1, { n: 1 }), sse(2, { n: 2 })),
      () => {
        throw new Error('socket hang up');
      },
      // The host replays from the transcript; the invoker drops what it has.
      () => chunks(sse(2, { n: 2 }), sse(3, { n: 3 }), sse(4, { type: 'result' })),
    ];
    const invoke: InvokeSession = async (payload) => {
      payloads.push(payload);
      return streams[payloads.length - 1]!();
    };
    const messages: unknown[] = [];
    const reconnects = await streamRun(invoke, { action: 'run' }, (m) => messages.push(m), ended(messages), options);
    assert.equal(reconnects, 2);
    assert.deepEqual(messages, [{ n: 1 }, { n: 2 }, { n: 3 }, { type: 'result' }]);
    assert.deepEqual(payloads, [{ action: 'run' }, { action: 'attach', after: 2 }, { action: 'attach', after: 2 }]);
  });

  it('attaches when the first run call finds the run already started', async () => {
    const payloads: object[] = [];
    const invoke: InvokeSession = async (payload) => {
      payloads.push(payload);
      if (payloads.length === 1) throw new Error('Received error (409) from runtime.');
      return chunks(sse(1, { type: 'result' }));
    };
    const messages: unknown[] = [];
    await streamRun(invoke, { action: 'run' }, (m) => messages.push(m), ended(messages), options);
    assert.deepEqual(payloads, [{ action: 'run' }, { action: 'attach', after: 0 }]);
  });

  it('re-attaches from the last message delivered when the numbering skips or is missing', async () => {
    const payloads: object[] = [];
    const streams = [
      () => chunks(sse(1, { n: 1 }), sse(5, { forged: true })),
      () => chunks('data: {"unnumbered":true}\n\n'),
      () => chunks(sse(2, { n: 2 }), sse(3, { type: 'result' })),
    ];
    const invoke: InvokeSession = async (payload) => {
      payloads.push(payload);
      return streams[payloads.length - 1]!();
    };
    const messages: unknown[] = [];
    await streamRun(invoke, { action: 'run' }, (m) => messages.push(m), ended(messages), options);
    assert.deepEqual(messages, [{ n: 1 }, { n: 2 }, { type: 'result' }]);
    assert.deepEqual(payloads, [{ action: 'run' }, { action: 'attach', after: 1 }, { action: 'attach', after: 1 }]);
  });

  it('gives up when attach finds no run, or after its reconnects', async () => {
    let calls = 0;
    const noRun: InvokeSession = async () => {
      calls += 1;
      if (calls === 1) return chunks(sse(1, { n: 1 }));
      throw new Error('Received error (409) from runtime.');
    };
    await assert.rejects(streamRun(noRun, { action: 'run' }, () => {}, () => false, options), /409/);

    const forever: InvokeSession = async () => chunks();
    await assert.rejects(streamRun(forever, { action: 'run' }, () => {}, () => false, options), /without its result after 3 reconnects/);
  });
});
