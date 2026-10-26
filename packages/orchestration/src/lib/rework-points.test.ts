import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WorkItemReviewDetail } from '@factorial/workitem';

import { commentToAcknowledge, inlineCommentIdFromUrl, pointOrigins, reviewIdFromUrl, reworkPoints } from './rework-points.ts';

const details: WorkItemReviewDetail[] = [{ author: 'alice', body: 'Rename it.' }];

describe('review points', () => {
  it('finds the comment to acknowledge, of either kind, and none for a review or a run', () => {
    assert.deepEqual(commentToAcknowledge('https://github.com/o/r/pull/26#issuecomment-9'), { kind: 'conversation', id: 9 });
    assert.deepEqual(commentToAcknowledge('https://github.com/o/r/pull/26#discussion_r5'), { kind: 'inline', id: 5 });
    assert.equal(commentToAcknowledge('https://github.com/o/r/pull/26#pullrequestreview-77'), undefined);
    assert.equal(commentToAcknowledge('https://github.com/o/r/actions/runs/3'), undefined);
  });

  it('reads the comment id from an inline comment URL only', () => {
    assert.equal(inlineCommentIdFromUrl('https://github.com/o/r/pull/26#discussion_r5'), 5);
    assert.equal(inlineCommentIdFromUrl('https://github.com/o/r/pull/26#issuecomment-9'), undefined);
    assert.equal(inlineCommentIdFromUrl('https://github.com/o/r/pull/26#pullrequestreview-77'), undefined);
  });

  it('reads the review id from a review URL only', () => {
    assert.equal(reviewIdFromUrl('https://github.com/o/r/pull/26#pullrequestreview-77'), 77);
    assert.equal(reviewIdFromUrl('https://github.com/o/r/pull/26#issuecomment-9'), undefined);
    assert.equal(reviewIdFromUrl('https://github.com/o/r/pull/26#discussion_r5'), undefined);
  });

  it("puts the item's details first, then the review's comments without bots or empty ones, capped at 50", () => {
    const comments = [
      { authorLogin: 'alice', authorType: 'User', path: 'a.ts', line: 3, body: ' Inline. ' },
      { authorLogin: 'ci[bot]', authorType: 'Bot', path: 'a.ts', line: 1, body: 'noise' },
      { authorLogin: 'bob', authorType: 'User', path: 'b.ts', line: undefined, body: '  ' },
    ];
    assert.deepEqual(reworkPoints(details, comments), [
      { author: 'alice', body: 'Rename it.' },
      { author: 'alice', path: 'a.ts', line: 3, body: 'Inline.' },
    ]);
    const many = Array.from({ length: 60 }, (_, i) => ({ authorLogin: 'a', authorType: 'User', path: `f${i}`, line: 1, body: 'x' }));
    assert.equal(reworkPoints(details, many).length, 50);
  });

  it('keeps only who and where for the state', () => {
    assert.deepEqual(pointOrigins([{ author: 'alice', path: 'a.ts', line: 3, body: 'secret text' }, { author: 'bob', body: 'b' }]), [
      { author: 'alice', path: 'a.ts', line: 3 },
      { author: 'bob' },
    ]);
  });
});
