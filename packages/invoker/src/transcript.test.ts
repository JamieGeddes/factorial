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
      transcript.append({ contentBlockDelta: { delta: { text: 'x'.repeat(100) } } }, at);
    }
    const summary = transcript.close();
    const written = lines(transcript.path);
    assert.equal(summary.truncated, true);
    assert.equal(summary.events + summary.droppedEvents, 100);
    assert.ok(readFileSync(transcript.path).length <= 4096);
    assert.deepEqual(written.at(-1), { truncated: true, keptEvents: summary.events, droppedEvents: summary.droppedEvents, maxBytes: 4096 });
    assert.equal(written.length, summary.events + 1);
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
