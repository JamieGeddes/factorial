import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { TranscriptBuffer } from './transcript.ts';

const at = new Date('2026-10-19T09:00:00Z');

function buffer(maxBytes?: number): TranscriptBuffer {
  return new TranscriptBuffer(join(mkdtempSync(join(tmpdir(), 'transcript-')), 'transcript.jsonl'), maxBytes);
}

function lines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('TranscriptBuffer', () => {
  it('writes one JSON line per event, with its time', () => {
    const transcript = buffer();
    transcript.append({ messageStart: { role: 'assistant' } }, at);
    transcript.append({ messageStop: { stopReason: 'end_turn' } }, at);
    const summary = transcript.close();
    assert.deepEqual(lines(transcript.path), [
      { at: '2026-10-19T09:00:00.000Z', messageStart: { role: 'assistant' } },
      { at: '2026-10-19T09:00:00.000Z', messageStop: { stopReason: 'end_turn' } },
    ]);
    assert.equal(summary.events, 2);
    assert.equal(summary.truncated, false);
    assert.equal(summary.bytes, readFileSync(transcript.path).length);
  });

  it('redacts a planted token before it reaches the disk', () => {
    const transcript = buffer();
    const token = `ghs_${'A'.repeat(36)}`;
    transcript.append({ contentBlockDelta: { delta: { text: `export GH_TOKEN=${token}` } } }, at);
    transcript.close();
    const text = readFileSync(transcript.path, 'utf8');
    assert.doesNotMatch(text, /AAAAAAAAAAAA/);
    assert.match(text, /ghs_\*\*\*/);
    assert.doesNotThrow(() => lines(transcript.path));
  });

  it('stops at the cap and ends with a truncation marker', () => {
    const transcript = buffer(4096);
    for (let i = 0; i < 100; i += 1) {
      transcript.append({ messageStart: { role: 'x'.repeat(100) } }, at);
    }
    const summary = transcript.close();
    const written = lines(transcript.path);
    assert.equal(summary.truncated, true);
    assert.equal(summary.events + summary.droppedEvents, 100);
    assert.ok(readFileSync(transcript.path).length <= 4096);
    assert.deepEqual(written.at(-1), { truncated: true, keptEvents: summary.events, droppedEvents: summary.droppedEvents, maxBytes: 4096 });
    assert.equal(written.length, summary.events + 1);
  });

  it('redacts a token split across streamed deltas', () => {
    const transcript = buffer();
    const token = `ghs_${'B'.repeat(36)}`;
    for (const part of ['token is ', token.slice(0, 6), token.slice(6, 20), token.slice(20), ' done']) {
      transcript.append({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: part } } }, at);
    }
    transcript.append({ contentBlockStop: { contentBlockIndex: 0 } }, at);
    transcript.close();
    assert.doesNotMatch(readFileSync(transcript.path, 'utf8'), /BBBB/);
    assert.deepEqual(lines(transcript.path)[0], {
      at: '2026-10-19T09:00:00.000Z',
      contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'token is ghs_*** done' } },
    });
  });

  it('joins tool input deltas and keeps blocks apart', () => {
    const transcript = buffer();
    transcript.append({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'a' } } }, at);
    transcript.append({ contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"cmd":' } } } }, at);
    transcript.append({ contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '"ls"}' } } } }, at);
    const summary = transcript.close();
    assert.deepEqual(
      lines(transcript.path).map((line) => line.contentBlockDelta),
      [
        { contentBlockIndex: 0, delta: { text: 'a' } },
        { contentBlockIndex: 1, delta: { toolUse: { input: '{"cmd":"ls"}' } } },
      ],
    );
    assert.equal(summary.events, 3);
  });

  it('ignores events after it is closed, and closes once', () => {
    const transcript = buffer();
    transcript.append({ a: 1 }, at);
    const first = transcript.close();
    transcript.append({ b: 2 }, at);
    assert.deepEqual(transcript.close(), first);
    assert.equal(lines(transcript.path).length, 1);
  });
});
