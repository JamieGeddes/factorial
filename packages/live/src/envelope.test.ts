import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LIVE_ENVELOPE_MAX_BYTES, LIVE_FIELD_CAP_BYTES, cutToBytes, liveEnvelope, parseEnvelope } from './envelope.ts';

const context = { workItemId: '0e418ab8-1603-2ef7-10e1-ca78a0330833', attempt: 2, role: 'builder', stage: 'build', round: 1 };
const at = new Date('2026-10-31T12:00:00.000Z');
const envelope = (event: unknown) => {
  const parsed = parseEnvelope(liveEnvelope(context, 7, at, event));
  assert.ok(parsed);
  return parsed;
};

test('the envelope says where the event belongs, its number and when it arrived', () => {
  assert.deepEqual(envelope({ type: 'text', text: 'hello' }), {
    workItemId: context.workItemId,
    attempt: 2,
    role: 'builder',
    stage: 'build',
    round: 1,
    seq: 7,
    at: '2026-10-31T12:00:00.000Z',
    event: { type: 'text', text: 'hello' },
  });
});

test('a 1 MB tool result is cut to 16 KiB from its start, with its size', () => {
  const content = `start ${'x'.repeat(1024 * 1024)}`;
  const published = envelope({ type: 'tool.result', callId: 'c1', content });
  assert.equal(published.truncated, true);
  assert.equal(published.bytes, Buffer.byteLength(content));
  const kept = published.event.content as string;
  assert.ok(kept.startsWith('start '));
  assert.equal(Buffer.byteLength(kept), LIVE_FIELD_CAP_BYTES);
});

test('text, reasoning and tool input are capped the same way', () => {
  const long = 'y'.repeat(LIVE_FIELD_CAP_BYTES + 10);
  for (const event of [{ type: 'text', text: long }, { type: 'reasoning', text: long }]) {
    const published = envelope(event);
    assert.equal(published.truncated, true);
    assert.equal(Buffer.byteLength(published.event.text as string), LIVE_FIELD_CAP_BYTES);
  }
  const call = envelope({ type: 'tool.call', callId: 'c1', tool: 'write', input: { path: 'a', content: long } });
  assert.equal(call.truncated, true);
  assert.equal(typeof call.event.input, 'string');
  assert.ok((call.event.input as string).startsWith('{"path":"a"'));
  const small = envelope({ type: 'tool.call', callId: 'c2', tool: 'read', input: { path: 'a' } });
  assert.deepEqual(small.event.input, { path: 'a' });
  assert.equal(small.truncated, undefined);
});

test('a harness event carries its name only', () => {
  assert.deepEqual(envelope({ type: 'harness', name: 'pi.session', message: { secret: 'internal' } }).event, { type: 'harness', name: 'pi.session' });
});

test('credentials are redacted before the cut, so none survives at the boundary', () => {
  const token = `ghs_${'A'.repeat(40)}`;
  const text = `${'z'.repeat(LIVE_FIELD_CAP_BYTES - 10)}${token}`;
  const published = envelope({ type: 'text', text });
  assert.ok(!(published.event.text as string).includes('AAAAAAAAAA'));
  assert.ok(!liveEnvelope(context, 1, at, { type: 'tool.call', callId: 'c', tool: 'bash', input: { cmd: `echo ${token}` } }).includes(token));
});

test('an event too large even when capped is sent as its type', () => {
  const published = envelope({ type: 'run.ended', outcome: 'failed', reason: 'host_error', errors: Array.from({ length: 50 }, () => 'e'.repeat(4000)) });
  assert.deepEqual(published.event, { type: 'run.ended', omitted: true });
  assert.equal(published.truncated, true);
  assert.ok((published.bytes ?? 0) > LIVE_ENVELOPE_MAX_BYTES);
});

test('something that is not an event is published as unknown, never thrown on', () => {
  assert.deepEqual(envelope('just text').event, { type: 'unknown' });
  assert.deepEqual(envelope(null).event, { type: 'unknown' });
});

test('a cut never splits a character', () => {
  assert.equal(cutToBytes('aé', 2), 'a');
  assert.equal(cutToBytes('a😀b', 4), 'a');
  assert.equal(cutToBytes('a😀b', 5), 'a😀');
  assert.equal(cutToBytes('short', 100), 'short');
});

test('parseEnvelope refuses what is not an envelope', () => {
  assert.equal(parseEnvelope('not json'), undefined);
  assert.equal(parseEnvelope('{"seq":"1","event":{}}'), undefined);
  assert.equal(parseEnvelope('{"seq":1}'), undefined);
});
