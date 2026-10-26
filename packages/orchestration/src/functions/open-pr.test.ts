import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ReworkContext } from '@factorial/workitem';

import { reviewersToRequest } from './open-pr.ts';

const rework: ReworkContext = {
  kind: 'rework',
  pullRequest: { number: 26, url: 'https://github.com/JamieGeddes/factorial/pull/26' },
  branch: 'factorial/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  baseBranch: 'main',
  previousWorkItemId: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  cause: 'review',
  details: [
    { author: 'alice', body: 'a' },
    { author: 'bob', path: 'x.ts', body: 'b' },
    { author: 'alice', body: 'c' },
    { author: 'factorial-x[bot]', body: 'd' },
    { author: 'not a login', body: 'e' },
  ],
};

describe('reviewersToRequest', () => {
  it('asks each person who raised a point once, never a bot or an invalid login', () => {
    assert.deepEqual(reviewersToRequest(rework), ['alice', 'bob']);
  });

  it("uses Prepare's numbered points when the context has them, so a review's inline commenters are asked too", () => {
    assert.deepEqual(reviewersToRequest(rework, [{ author: 'carol', path: 'a.ts' }, { author: 'alice' }]), ['carol', 'alice']);
  });

  it('asks nobody after a checks-failed rework or a conversation request', () => {
    assert.deepEqual(reviewersToRequest({ ...rework, cause: 'checks-failed' }), []);
    assert.deepEqual(reviewersToRequest({ ...rework, cause: 'comment' }), []);
  });
});
