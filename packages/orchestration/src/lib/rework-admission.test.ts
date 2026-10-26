import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PullRequestState } from '@factorial/github-app';
import type { ReworkContext } from '@factorial/workitem';

import { admitRework, commentToAcknowledge, inlineCommentIdFromUrl, pointOrigins, pullRequestMismatch, reviewIdFromUrl, reworkPoints, type EarlierItem } from './rework-admission.ts';

const BRANCH = 'factorial/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c';
const BOT = 'factorial-x[bot]';
const NOW = new Date('2026-10-26T12:00:00.000Z');
const MINE = '2026-10-26T11:59:00.000Z';

const rework: ReworkContext = {
  kind: 'rework',
  pullRequest: { number: 26, url: 'https://github.com/JamieGeddes/factorial/pull/26' },
  branch: BRANCH,
  baseBranch: 'main',
  previousWorkItemId: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  cause: 'review',
  details: [{ author: 'alice', body: 'Rename it.' }],
};

const pr: PullRequestState = {
  number: 26,
  state: 'open',
  authorLogin: BOT,
  headRef: BRANCH,
  headSha: 'a'.repeat(40),
  headRepoId: 42,
  baseRef: 'main',
  baseRepoId: 42,
};

describe('pullRequestMismatch', () => {
  it('accepts an open pull request Factorial opened on this branch, whatever the login case', () => {
    assert.equal(pullRequestMismatch(pr, rework, BOT), undefined);
    assert.equal(pullRequestMismatch({ ...pr, authorLogin: 'Factorial-X[bot]' }, rework, BOT), undefined);
  });

  it('refuses a closed pull request, another author, a fork and a branch that does not match', () => {
    assert.match(pullRequestMismatch({ ...pr, state: 'closed' }, rework, BOT) ?? '', /is closed/);
    assert.match(pullRequestMismatch({ ...pr, authorLogin: 'alice' }, rework, BOT) ?? '', /not opened by Factorial/);
    assert.match(pullRequestMismatch({ ...pr, headRepoId: 7 }, rework, BOT) ?? '', /another repository/);
    assert.match(pullRequestMismatch({ ...pr, headRepoId: undefined }, rework, BOT) ?? '', /another repository/);
    assert.match(pullRequestMismatch({ ...pr, headRef: 'factorial/other' }, rework, BOT) ?? '', /is on factorial\/other, not factorial\//);
  });
});

const item = (id: string, minutesAgo: number, status: string, cause?: string): EarlierItem => ({
  workItemId: id,
  status,
  createdAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  ...(cause ? { cause } : {}),
});

const review = { workItemId: 'me', createdAt: MINE, cause: 'review' as const };
const checks = { workItemId: 'me', createdAt: MINE, cause: 'checks-failed' as const };

describe('admitRework: one item in flight', () => {
  it('admits when every earlier item has finished', () => {
    assert.deepEqual(admitRework(review, [item('a', 30, 'pr-updated'), item('b', 90, 'tests-failed')], NOW), { ok: true });
  });

  it('refuses while an earlier item runs, replying when a person asked', () => {
    const admission = admitRework(review, [item('a', 10, 'testing')], NOW);
    assert.equal(admission.ok, false);
    if (admission.ok) return;
    assert.equal(admission.status, 'busy');
    assert.match(admission.reply ?? '', /already working on this pull request \(work item `a`\)/);
  });

  it('replies to a conversation request refused while an item runs', () => {
    const admission = admitRework({ ...review, cause: 'comment' }, [item('a', 10, 'testing')], NOW);
    assert.ok(!admission.ok && admission.status === 'busy' && admission.reply !== undefined);
  });

  it('starts the automatic count again after a conversation request', () => {
    const earlier = [item('c', 10, 'pr-updated', 'checks-failed'), item('b', 20, 'pr-updated', 'comment'), item('a', 30, 'pr-updated', 'checks-failed')];
    assert.equal(admitRework(checks, earlier, NOW).ok, true);
  });

  it('refuses failed checks quietly while an item runs, since they arrive during its own tests', () => {
    const admission = admitRework(checks, [item('a', 10, 'building')], NOW);
    assert.ok(!admission.ok && admission.status === 'busy' && admission.reply === undefined);
  });

  it('ignores itself, items accepted after it, and items stale for 8 hours', () => {
    const later = { workItemId: 'z', status: 'accepted', createdAt: '2026-10-26T11:59:30.000Z' };
    assert.deepEqual(admitRework(review, [later, { ...review, status: 'accepted' }, item('old', 9 * 60, 'building')], NOW), { ok: true });
  });

  it('lets exactly one of two items accepted at the same moment run', () => {
    const a = { workItemId: 'a', createdAt: MINE, cause: 'review' as const };
    const b = { workItemId: 'b', createdAt: MINE, cause: 'review' as const };
    const rows = [
      { workItemId: 'a', status: 'accepted', createdAt: MINE },
      { workItemId: 'b', status: 'accepted', createdAt: MINE },
    ];
    assert.equal(admitRework(a, rows, NOW).ok, true);
    assert.equal(admitRework(b, rows, NOW).ok, false);
  });
});

describe('admitRework: automatic reworks after failed checks', () => {
  it('admits up to two in a row', () => {
    assert.equal(admitRework(checks, [], NOW).ok, true);
    assert.equal(admitRework(checks, [item('a', 20, 'tests-failed', 'checks-failed')], NOW).ok, true);
  });

  it('refuses a third, replying once', () => {
    const earlier = [item('b', 20, 'pr-updated', 'checks-failed'), item('a', 40, 'tests-failed', 'checks-failed')];
    const admission = admitRework(checks, earlier, NOW);
    assert.ok(!admission.ok && admission.status === 'rework-limit');
    if (!admission.ok) assert.match(admission.reply ?? '', /already tried to fix the failing checks on this pull request 2 times/);
    const again = admitRework(checks, [item('c', 10, 'rework-limit', 'checks-failed'), ...earlier], NOW);
    assert.ok(!again.ok && again.status === 'rework-limit' && again.reply === undefined);
  });

  it('starts counting again after a person asks', () => {
    const earlier = [item('c', 10, 'pr-updated', 'checks-failed'), item('b', 20, 'pr-updated', 'review'), item('a', 30, 'pr-updated', 'checks-failed')];
    assert.equal(admitRework(checks, earlier, NOW).ok, true);
  });

  it('does not count refused items as attempts', () => {
    const earlier = [item('b', 10, 'busy', 'checks-failed'), item('a', 20, 'not-eligible', 'checks-failed'), item('x', 30, 'pr-updated', 'checks-failed')];
    assert.equal(admitRework(checks, earlier, NOW).ok, true);
  });

  it('never limits a review-caused item', () => {
    const earlier = [item('b', 20, 'pr-updated', 'checks-failed'), item('a', 40, 'pr-updated', 'checks-failed')];
    assert.equal(admitRework(review, earlier, NOW).ok, true);
  });
});

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

  it('does not count an inline comment covered by its review as an attempt or a running item', () => {
    assert.equal(admitRework(checks, [item('b', 1, 'covered-by-review', 'review'), item('a', 20, 'tests-failed', 'checks-failed')], NOW).ok, true);
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
    assert.deepEqual(reworkPoints(rework.details, comments), [
      { author: 'alice', body: 'Rename it.' },
      { author: 'alice', path: 'a.ts', line: 3, body: 'Inline.' },
    ]);
    const many = Array.from({ length: 60 }, (_, i) => ({ authorLogin: 'a', authorType: 'User', path: `f${i}`, line: 1, body: 'x' }));
    assert.equal(reworkPoints(rework.details, many).length, 50);
  });

  it('keeps only who and where for the state', () => {
    assert.deepEqual(pointOrigins([{ author: 'alice', path: 'a.ts', line: 3, body: 'secret text' }, { author: 'bob', body: 'b' }]), [
      { author: 'alice', path: 'a.ts', line: 3 },
      { author: 'bob' },
    ]);
  });
});
