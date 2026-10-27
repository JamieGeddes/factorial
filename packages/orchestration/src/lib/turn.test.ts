import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ReworkContext, WorkItem } from '@factorial/workitem';

import { CHECKS_AUTHOR, POINT_MAX, claimedBranch, continuedPullRequest, reworkCause, reworkDetails } from './turn.ts';

const BRANCH = 'factorial/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c';

const issue: WorkItem = {
  schemaVersion: 1,
  id: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  source: { type: 'github-issue', id: '7', url: 'https://github.com/JamieGeddes/factorial/issues/7' },
  repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' },
  title: 'Fix typo',
  body: 'Fix it.',
  requestedBy: 'alice',
  createdAt: '2026-10-27T09:00:00Z',
};

const context: ReworkContext = {
  kind: 'rework',
  pullRequest: { number: 26, url: 'https://github.com/JamieGeddes/factorial/pull/26' },
  branch: BRANCH,
  baseBranch: 'main',
  previousWorkItemId: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  cause: 'checks-failed',
  details: [{ author: 'github-actions', body: 'The workflow "CI" failed.' }],
};
const legacy: WorkItem = { ...issue, source: { type: 'github-pull-request', id: '26', url: 'https://github.com/JamieGeddes/factorial/actions/runs/3' }, context };

const reply = (type: string, url: string, body = 'Rename it.'): WorkItem => ({
  ...issue,
  source: { type, id: '9', url },
  inReplyTo: { kind: 'pull-request', number: 26 },
  body,
});

describe('a new request', () => {
  it('continues nothing and carries no rework facts', () => {
    assert.equal(continuedPullRequest(issue), undefined);
    assert.equal(reworkCause(issue), undefined);
    assert.equal(claimedBranch(issue), undefined);
  });
});

describe('the superseded rework context', () => {
  it('gives its own pull request, cause, details and branch', () => {
    assert.deepEqual(continuedPullRequest(legacy), context.pullRequest);
    assert.equal(reworkCause(legacy), 'checks-failed');
    assert.deepEqual(reworkDetails(legacy), context.details);
    assert.equal(claimedBranch(legacy), BRANCH);
  });
});

describe('an item in reply to a pull request', () => {
  it('names the pull request in its repository', () => {
    assert.deepEqual(continuedPullRequest(reply('github-pull-request-comment', 'https://x')), {
      number: 26,
      url: 'https://github.com/JamieGeddes/factorial/pull/26',
    });
  });

  it('derives the cause from what happened', () => {
    assert.equal(reworkCause(reply('github-pull-request-review', 'https://x')), 'review');
    assert.equal(reworkCause(reply('github-pull-request-review-comment', 'https://x')), 'review');
    assert.equal(reworkCause(reply('github-pull-request-comment', 'https://x')), 'comment');
    assert.equal(reworkCause(reply('github-workflow-run', 'https://x')), 'checks-failed');
  });

  it('has no cause for a source type Factorial does not know', () => {
    assert.equal(reworkCause(reply('github-pull-request-label', 'https://x')), undefined);
  });

  it('carries what was said as its one point, by whoever said it', () => {
    assert.deepEqual(reworkDetails(reply('github-pull-request-comment', 'https://x', '  Rename it.  ')), [{ author: 'alice', body: 'Rename it.' }]);
    assert.deepEqual(reworkDetails(reply('github-workflow-run', 'https://x', 'The workflow "CI" failed.')), [{ author: CHECKS_AUTHOR, body: 'The workflow "CI" failed.' }]);
  });

  it('caps the point as the contract capped a detail', () => {
    const [point] = reworkDetails(reply('github-pull-request-comment', 'https://x', 'x'.repeat(9_000)));
    assert.equal(point?.body.length, POINT_MAX);
  });

  it('carries no point for a review with no text: its inline comments are fetched when seeding', () => {
    assert.deepEqual(reworkDetails(reply('github-pull-request-review', 'https://x', ' ')), []);
  });

  it('names no branch: the thread does', () => {
    assert.equal(claimedBranch(reply('github-pull-request-comment', 'https://x')), undefined);
  });
});
