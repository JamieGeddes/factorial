import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GitHubApiError, type PullRequestClose, type Repo } from '@factorial/github-app';
import { createLogger } from '@factorial/log';
import type { LedgerRow, PullRequestOutcome } from '@factorial/progress';
import { validatePullRequestClosed, type PullRequestClosed } from '@factorial/pull-request-closed';

import { outcomeUpdate, type OutcomeTarget, type ThreadAwaitingOutcome } from './thread.ts';
import { recordPullRequestClosed } from './thread-outcome.ts';
import { MISSED_CLOSES_METRIC, UNKNOWN_ACTOR, WEBHOOK_GRACE_MS, closedEvent, missedCloseMetrics, reconcileThreads, type ReconcileDeps } from './thread-reconcile.ts';

const NOW = new Date('2026-11-01T12:00:00Z');
const LONG_AGO = '2026-10-31T15:29:00Z';
const SHA = 'a'.repeat(40);

const thread = (number: number, extra: Partial<ThreadAwaitingOutcome> = {}): ThreadAwaitingOutcome & { outcome?: PullRequestOutcome } => ({
  threadKey: `jamiegeddes/factorial#factorial/00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
  owner: 'JamieGeddes',
  name: 'factorial',
  branch: `factorial/00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
  prNumber: number,
  prOpenedBy: `00000000-0000-4000-9000-${String(number).padStart(12, '0')}`,
  ...extra,
});

const open = (t: ThreadAwaitingOutcome): PullRequestClose => ({
  number: t.prNumber,
  htmlUrl: `https://github.com/JamieGeddes/factorial/pull/${t.prNumber}`,
  state: 'open',
  headRef: t.branch,
  merged: false,
  closedAt: undefined,
  mergedAt: undefined,
  mergeCommit: undefined,
  mergedBy: undefined,
});

const merged = (t: ThreadAwaitingOutcome, at = LONG_AGO, by: string | null = 'alice'): PullRequestClose => ({
  ...open(t),
  state: 'closed',
  merged: true,
  closedAt: at,
  mergedAt: at,
  mergeCommit: SHA,
  mergedBy: by ?? undefined,
});

const closed = (t: ThreadAwaitingOutcome, at = LONG_AGO): PullRequestClose => ({ ...open(t), state: 'closed', closedAt: at });

/**
 * Threads in memory behind the webhook's own recording path, with the
 * reconciler's first-only write. GitHub answers from `pulls`; a function
 * there stands in for an error.
 */
function harness(threads: Array<ThreadAwaitingOutcome & { outcome?: PullRequestOutcome }>, pulls: Record<number, PullRequestClose | (() => never)>, closers: Record<number, string> = {}) {
  const logs: Array<Record<string, unknown> & { level: string; message: string }> = [];
  const announced: Array<{ prNumber: number; outcome: PullRequestOutcome }> = [];
  const counted: Array<Map<string, number>> = [];
  const byKey = new Map(threads.map((t) => [t.threadKey, t]));
  const log = createLogger('thread-reconcile', {}, (line) => logs.push(JSON.parse(line) as never));
  const deps: ReconcileDeps = {
    threadsAwaitingOutcome: async () => threads.map((t) => structuredClone(t)),
    pullRequest: async (_repo: Repo, number) => {
      const answer = pulls[number];
      if (typeof answer === 'function') return answer();
      assert.ok(answer, `no pull request #${number}`);
      return answer;
    },
    closedBy: async (_repo, number) => closers[number],
    record: (event: PullRequestClosed) =>
      recordPullRequestClosed(event, {
        threadKeyFor: async (key) => threads.find((t) => `jamiegeddes/factorial#${t.prNumber}` === key)?.threadKey,
        recordOutcome: async (target: OutcomeTarget, outcome) => {
          const t = byKey.get(target.threadKey);
          if (!t) return { recorded: false };
          // The first-only condition: no outcome at all.
          if (t.prNumber !== target.prNumber || t.branch !== target.branch || t.outcome) return { recorded: false, thread: structuredClone(t) };
          t.outcome = structuredClone(outcome);
          return { recorded: true, thread: structuredClone(t) };
        },
        ledgerRow: async (id) => ({ workItemId: id }) as LedgerRow,
        announce: async (_row, prNumber, outcome) => {
          announced.push({ prNumber, outcome });
        },
        log,
      }),
    countMissed: async (missed) => {
      counted.push(new Map(missed));
    },
    log,
    now: () => NOW,
  };
  return { deps, logs, announced, counted, byKey };
}

describe('reconcileThreads', () => {
  it('leaves an open pull request alone', async () => {
    const t = thread(240);
    const h = harness([t], { 240: open(t) });
    const summary = await reconcileThreads(h.deps);
    assert.equal(summary.open, 1);
    assert.equal(h.byKey.get(t.threadKey)?.outcome, undefined);
    assert.equal(h.announced.length, 0);
    assert.equal(h.counted.length, 0);
  });

  it('records a merge with who merged it, announces it, and counts it as missed', async () => {
    const t = thread(226);
    const h = harness([t], { 226: merged(t) });
    const summary = await reconcileThreads(h.deps);
    assert.equal(summary.recorded, 1);
    assert.deepEqual(h.byKey.get(t.threadKey)?.outcome, { state: 'merged', at: LONG_AGO, by: 'alice', mergeCommit: SHA });
    assert.deepEqual(h.announced, [{ prNumber: 226, outcome: { state: 'merged', at: LONG_AGO, by: 'alice', mergeCommit: SHA } }]);
    assert.deepEqual(h.counted, [new Map([['JamieGeddes/factorial', 1]])]);
    const line = h.logs.find((l) => l.message === 'missed close recorded');
    assert.equal(line?.workItemId, t.prOpenedBy);
    assert.equal(line?.pullRequest, 'jamiegeddes/factorial#226');
  });

  it('records a close without merging, with who closed it from the issues API', async () => {
    const t = thread(212);
    const h = harness([t], { 212: closed(t) }, { 212: 'bob' });
    await reconcileThreads(h.deps);
    assert.deepEqual(h.byKey.get(t.threadKey)?.outcome, { state: 'closed', at: LONG_AGO, by: 'bob' });
    assert.deepEqual(h.counted, [new Map([['JamieGeddes/factorial', 1]])]);
  });

  it(`records a close by a deleted account as ${UNKNOWN_ACTOR}`, async () => {
    const a = thread(1);
    const b = thread(2);
    const h = harness([a, b], { 1: merged(a, LONG_AGO, null), 2: closed(b) });
    await reconcileThreads(h.deps);
    assert.equal(h.byKey.get(a.threadKey)?.outcome?.by, UNKNOWN_ACTOR);
    assert.equal(h.byKey.get(b.threadKey)?.outcome?.by, UNKNOWN_ACTOR);
  });

  it('counts every missed close of a run in one call', async () => {
    const a = thread(1);
    const b = thread(2);
    const c = thread(3);
    const h = harness([a, b, c], { 1: merged(a), 2: closed(b), 3: open(c) }, { 2: 'bob' });
    const summary = await reconcileThreads(h.deps);
    assert.deepEqual({ recorded: summary.recorded, open: summary.open }, { recorded: 2, open: 1 });
    assert.deepEqual(h.counted, [new Map([['JamieGeddes/factorial', 2]])]);
  });

  it('skips a thread whose outcome is already recorded, without reading GitHub', async () => {
    const t = thread(233, { outcome: { state: 'merged', at: LONG_AGO, by: 'alice' } } as never);
    const h = harness([t], { 233: () => assert.fail('GitHub read for a recorded thread') });
    const summary = await reconcileThreads(h.deps);
    assert.equal(summary.skipped, 1);
    assert.equal(h.counted.length, 0);
  });

  it('neither records nor counts a close the webhook recorded while the run was reading', async () => {
    const t = thread(236);
    const h = harness([t], { 236: merged(t) });
    // The webhook's write lands between the scan and the reconciler's write.
    h.byKey.get(t.threadKey)!.outcome = { state: 'merged', at: LONG_AGO, by: 'alice', mergeCommit: SHA };
    const summary = await reconcileThreads(h.deps);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.recorded, 0);
    assert.equal(h.announced.length, 0);
    assert.equal(h.counted.length, 0);
  });

  it('leaves a close within the grace period to the webhook', async () => {
    const t = thread(250);
    const recent = new Date(NOW.getTime() - WEBHOOK_GRACE_MS + 60_000).toISOString();
    const h = harness([t], { 250: merged(t, recent) });
    const summary = await reconcileThreads(h.deps);
    assert.equal(summary.recent, 1);
    assert.equal(h.byKey.get(t.threadKey)?.outcome, undefined);
  });

  it('logs a 404 and an API error and goes on with the other threads', async () => {
    const gone = thread(1);
    const failing = thread(2);
    const fine = thread(3);
    const h = harness([gone, failing, fine], {
      1: () => {
        throw new GitHubApiError('GET', '/repos/JamieGeddes/factorial/pulls/1', 404, 'Not Found');
      },
      2: () => {
        throw new GitHubApiError('GET', '/repos/JamieGeddes/factorial/pulls/2', 502, 'Bad Gateway');
      },
      3: merged(fine),
    });
    const summary = await reconcileThreads(h.deps);
    assert.deepEqual({ failed: summary.failed, recorded: summary.recorded }, { failed: 2, recorded: 1 });
    const errors = h.logs.filter((l) => l.level === 'error');
    assert.deepEqual(
      errors.map((l) => [l.pullRequest, l.status]),
      [
        ['jamiegeddes/factorial#1', 404],
        ['jamiegeddes/factorial#2', 502],
      ],
    );
    assert.equal(h.byKey.get(fine.threadKey)?.outcome?.state, 'merged');
  });

  it('logs a summary of the run', async () => {
    const t = thread(240);
    const h = harness([t], { 240: open(t) });
    await reconcileThreads(h.deps);
    const line = h.logs.at(-1);
    assert.equal(line?.message, 'reconciled');
    assert.equal(line?.threads, 1);
  });
});

describe('the reconciled close', () => {
  it('fits the PullRequestClosed contract, merged or not', () => {
    const t = thread(226);
    const repo = { owner: 'JamieGeddes', name: 'factorial' };
    assert.deepEqual(validatePullRequestClosed(closedEvent(repo, merged(t), 'alice')).ok, true);
    const plain = closedEvent(repo, closed(t), 'bob');
    assert.deepEqual(validatePullRequestClosed(plain).ok, true);
    assert.equal('mergeCommit' in plain, false);
  });

  it('is written only where the thread holds no outcome at all', () => {
    const t = thread(226);
    const input = outcomeUpdate('factorial-threads', { threadKey: t.threadKey, prNumber: 226, branch: t.branch }, { state: 'merged', at: LONG_AGO, by: 'alice' }, { first: true });
    assert.equal(input.ConditionExpression, 'prNumber = :number AND #branch = :branch AND attribute_not_exists(#outcome)');
    assert.equal(input.ExpressionAttributeValues?.[':at'], undefined);
    assert.equal(input.ExpressionAttributeNames?.['#at'], undefined);
  });
});

describe('missedCloseMetrics', () => {
  it('puts one datapoint per repository and one in all, which the alarm watches', () => {
    assert.deepEqual(
      missedCloseMetrics(
        new Map([
          ['JamieGeddes/factorial', 2],
          ['JamieGeddes/other', 1],
        ]),
      ),
      [
        { MetricName: MISSED_CLOSES_METRIC, Dimensions: [{ Name: 'Repository', Value: 'JamieGeddes/factorial' }], Value: 2, Unit: 'Count' },
        { MetricName: MISSED_CLOSES_METRIC, Dimensions: [{ Name: 'Repository', Value: 'JamieGeddes/other' }], Value: 1, Unit: 'Count' },
        { MetricName: MISSED_CLOSES_METRIC, Value: 3, Unit: 'Count' },
      ],
    );
  });

  it('puts nothing for a run that missed nothing', () => {
    assert.deepEqual(missedCloseMetrics(new Map()), []);
  });
});
