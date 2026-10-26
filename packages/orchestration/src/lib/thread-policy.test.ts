import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PullRequestState } from '@factorial/github-app';

import { STALE_AFTER_MS, admitTurn, pullRequestMismatch, stateFromHistory, type ThreadState } from './thread-policy.ts';

const BRANCH = 'factorial/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c';
const BOT = 'factorial-x[bot]';
const NOW = new Date('2026-10-26T12:00:00.000Z');

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

const minutesAgo = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const held = (workItemId: string, minutes: number): ThreadState => ({ inFlight: { workItemId, since: minutesAgo(minutes) } });

const review = { workItemId: 'me', cause: 'review' as const };
const comment = { workItemId: 'me', cause: 'comment' as const };
const checks = { workItemId: 'me', cause: 'checks-failed' as const };
const request = { workItemId: 'me' };

describe('pullRequestMismatch', () => {
  it("accepts an open pull request Factorial opened on the thread's branch, whatever the login case", () => {
    assert.equal(pullRequestMismatch(pr, BRANCH, BOT), undefined);
    assert.equal(pullRequestMismatch({ ...pr, authorLogin: 'Factorial-X[bot]' }, BRANCH, BOT), undefined);
  });

  it('refuses a closed pull request, another author, a fork and a branch that does not match', () => {
    assert.match(pullRequestMismatch({ ...pr, state: 'closed' }, BRANCH, BOT) ?? '', /is closed/);
    assert.match(pullRequestMismatch({ ...pr, authorLogin: 'alice' }, BRANCH, BOT) ?? '', /not opened by Factorial/);
    assert.match(pullRequestMismatch({ ...pr, headRepoId: 7 }, BRANCH, BOT) ?? '', /another repository/);
    assert.match(pullRequestMismatch({ ...pr, headRepoId: undefined }, BRANCH, BOT) ?? '', /another repository/);
    assert.match(pullRequestMismatch({ ...pr, headRef: 'factorial/other' }, BRANCH, BOT) ?? '', /is on factorial\/other, not factorial\//);
  });
});

describe('admitTurn: one turn in flight', () => {
  it('admits on a thread nobody holds, claiming it now', () => {
    assert.deepEqual(admitTurn(review, {}, undefined, NOW), {
      ok: true,
      claim: { inFlight: { workItemId: 'me', since: NOW.toISOString() }, automaticReworks: 0, limitAnnounced: false },
    });
  });

  it('admits when the holder has finished, whatever way it ended', () => {
    for (const status of ['pr-updated', 'pr-opened', 'tests-failed', 'failed', 'no-changes', 'invalid-plan']) {
      assert.equal(admitTurn(review, held('a', 30), status, NOW).ok, true, status);
    }
  });

  it('refuses while the holder runs, replying when a person asked', () => {
    for (const turn of [review, comment]) {
      const admission = admitTurn(turn, held('a', 10), 'testing', NOW);
      assert.ok(!admission.ok && admission.status === 'busy');
      if (!admission.ok) assert.match(admission.reply ?? '', /already working on this pull request \(work item `a`\)/);
    }
  });

  it('refuses failed checks quietly while the holder runs, since they arrive during its own tests', () => {
    const admission = admitTurn(checks, held('a', 10), 'building', NOW);
    assert.ok(!admission.ok && admission.status === 'busy' && admission.reply === undefined);
  });

  it('treats a holder with no status as running, until it goes stale', () => {
    assert.equal(admitTurn(review, held('a', 10), undefined, NOW).ok, false);
    assert.equal(admitTurn(review, held('a', STALE_AFTER_MS / 60_000 + 1), 'building', NOW).ok, true);
  });

  it('admits its own claim again, keeping when it was made, so a retried Intake is not refused', () => {
    const admission = admitTurn(review, held('me', 1), 'accepted', NOW);
    assert.ok(admission.ok);
    if (admission.ok) assert.equal(admission.claim.inFlight.since, minutesAgo(1));
  });

  it('applies to a new or resumed request too, without a reply', () => {
    assert.equal(admitTurn(request, {}, undefined, NOW).ok, true);
    const admission = admitTurn(request, held('a', 10), 'building', NOW);
    assert.ok(!admission.ok && admission.reply === undefined);
  });
});

describe('admitTurn: automatic reworks after failed checks', () => {
  it('admits up to two in a row, counting each', () => {
    const first = admitTurn(checks, {}, undefined, NOW);
    assert.ok(first.ok && first.claim.automaticReworks === 1);
    const second = admitTurn(checks, { automaticReworks: 1 }, undefined, NOW);
    assert.ok(second.ok && second.claim.automaticReworks === 2);
  });

  it('refuses a third, announcing it once', () => {
    const admission = admitTurn(checks, { automaticReworks: 2 }, undefined, NOW);
    assert.ok(!admission.ok && admission.status === 'rework-limit' && admission.announces === true);
    if (!admission.ok) assert.match(admission.reply ?? '', /already tried to fix the failing checks on this pull request 2 times/);
    const again = admitTurn(checks, { automaticReworks: 2, limitAnnounced: true }, undefined, NOW);
    assert.ok(!again.ok && again.status === 'rework-limit' && again.reply === undefined && again.announces === undefined);
  });

  it('starts counting again, and may announce again, after a person asks', () => {
    for (const turn of [review, comment, request]) {
      const admission = admitTurn(turn, { automaticReworks: 2, limitAnnounced: true }, undefined, NOW);
      assert.ok(admission.ok && admission.claim.automaticReworks === 0 && admission.claim.limitAnnounced === false);
    }
  });

  it('keeps the announcement while automatic reworks continue', () => {
    const admission = admitTurn(checks, { automaticReworks: 1, limitAnnounced: true }, undefined, NOW);
    assert.ok(admission.ok && admission.claim.limitAnnounced === true);
  });

  it('checks the holder before the limit, so a busy thread is never announced as limited', () => {
    const admission = admitTurn(checks, { ...held('a', 10), automaticReworks: 2 }, 'testing', NOW);
    assert.ok(!admission.ok && admission.status === 'busy');
  });
});

describe('stateFromHistory', () => {
  const item = (workItemId: string, status: string, cause?: string) => ({ workItemId, status, ...(cause ? { cause } : {}) });

  it('counts automatic reworks in a row back to the last item a person asked for', () => {
    assert.deepEqual(stateFromHistory([item('c', 'pr-updated', 'checks-failed'), item('b', 'pr-updated', 'review'), item('a', 'pr-updated', 'checks-failed')]), {
      automaticReworks: 1,
      limitAnnounced: false,
    });
    assert.deepEqual(stateFromHistory([]), { automaticReworks: 0, limitAnnounced: false });
  });

  it('skips refused items, which never counted as attempts', () => {
    const history = [item('d', 'busy', 'checks-failed'), item('c', 'covered-by-review', 'review'), item('b', 'tests-failed', 'checks-failed'), item('a', 'pr-updated', 'checks-failed')];
    assert.equal(stateFromHistory(history).automaticReworks, 2);
  });

  it('carries over an announcement made by the newest item', () => {
    assert.equal(stateFromHistory([item('c', 'rework-limit', 'checks-failed'), item('b', 'pr-updated', 'checks-failed')]).limitAnnounced, true);
    assert.equal(stateFromHistory([item('d', 'busy'), item('c', 'rework-limit', 'checks-failed')]).limitAnnounced, false);
  });
});
