import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WorkContext } from '../lib/context.ts';

import { reworkComment, UntestedHeadError } from './open-pr.ts';

const sha = 'a'.repeat(40);

function reworkCtx(): WorkContext {
  return {
    workItem: {
      schemaVersion: 1,
      id: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
      source: { type: 'github-issue', id: '7', url: 'https://github.com/JamieGeddes/factorial/issues/7' },
      repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' },
      title: 'Fix typo',
      body: '',
      requestedBy: 'JamieGeddes',
      createdAt: '2026-10-17T09:00:00Z',
      context: {
        kind: 'rework',
        pullRequest: { number: 12, url: 'https://github.com/JamieGeddes/factorial/pull/12' },
        branch: 'factorial/previous',
        baseBranch: 'main',
        previousWorkItemId: 'old',
        cause: 'review',
        details: [],
      },
    },
    sessionId: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
    branch: 'factorial/previous',
    baseBranch: 'main',
    baseCommit: 'b'.repeat(40),
    factorialVersion: '0123456789abcdef0123456789abcdef01234567',
  };
}

describe('reworkComment', () => {
  it('announces the rework and carries the summary, evidence and closing reference', () => {
    const text = reworkComment(reworkCtx(), 'Addressed the review.', { runUrl: 'https://x/run/9', outcome: 'success' }, sha);
    assert.match(text, /^Factorial has pushed the reworked changes for review\./);
    assert.match(text, /Addressed the review\./);
    assert.match(text, /Closes #7/);
    assert.match(text, /\[success\]\(https:\/\/x\/run\/9\)/);
  });
});

describe('UntestedHeadError', () => {
  it('is named UntestedHead', () => {
    assert.equal(new UntestedHeadError('moved').name, 'UntestedHead');
  });
});
