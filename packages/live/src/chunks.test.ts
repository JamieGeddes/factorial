import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chunkLines, chunkPath, runFolder } from './chunks.ts';

test('chunk keys are four digits from 1, under the round folder after the first round', () => {
  assert.equal(chunkPath('build', 1, 1), 'build/live/0001.jsonl');
  assert.equal(chunkPath('build', 2, 12), 'build/round-2/live/0012.jsonl');
  assert.equal(chunkPath('review', 1, 10000), 'review/live/10000.jsonl');
  assert.equal(runFolder('build', 3), 'build/round-3');
  assert.throws(() => chunkPath('build', 1, 0));
});

test("a chunk's events are its lines with a seq, torn lines and markers skipped", () => {
  const text = [
    '{"at":"2026-10-31T12:00:00.000Z","request":{"role":"builder"}}',
    '{"at":"2026-10-31T12:00:01.000Z","seq":1,"type":"run.started"}',
    '{"at":"2026-10-31T12:00:02.000Z","seq":2,"type":"text","text":"hi"}',
    '{"truncated":true,"keptEvents":2}',
    '{"at":"2026-10-31T12:00:03.000Z","seq":3,"ty',
    '',
  ].join('\n');
  assert.deepEqual(
    chunkLines(text).map((line) => line.seq),
    [1, 2],
  );
});
