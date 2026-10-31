import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLogger } from '@factorial/log';
import { progressEventErrors, progressEvent, type LedgerRow, type PullRequestOutcome } from '@factorial/progress';

import type { PullRequestClosed } from '@factorial/pull-request-closed';

import closedJson from '../../../../contracts/pull-request-closed/v1/examples/closed.json' with { type: 'json' };
import mergedJson from '../../../../contracts/pull-request-closed/v1/examples/merged.json' with { type: 'json' };
import { outcomeUpdate, type OutcomeTarget, type Thread } from './thread.ts';
import { outcomeOf, recordPullRequestClosed, type ThreadOutcomeDeps } from './thread-outcome.ts';

const mergedExample = mergedJson as PullRequestClosed;
const closedExample = closedJson as PullRequestClosed;
const OPENED_BY = 'c8db78d0-d4bd-11f1-8764-65fa7aa28432';
const THREAD = `jamiegeddes/factorial#${mergedExample.headBranch}`;

/** One thread in memory, applying the same condition as outcomeUpdate. */
function harness(thread: Partial<Thread> | undefined, options: { indexed?: boolean; row?: boolean } = {}) {
  const logs: Array<{ level: string; message: string; workItemId?: string; reason?: string }> = [];
  const announced: Array<{ row: LedgerRow; prNumber: number; outcome: PullRequestOutcome }> = [];
  let writes = 0;
  const row: LedgerRow = {
    workItemId: OPENED_BY,
    attempt: 1,
    threadKey: THREAD,
    workItem: { source: { type: 'github-issue', url: 'https://github.com/JamieGeddes/factorial/issues/219' }, repository: mergedExample.repository },
  };
  const deps: ThreadOutcomeDeps = {
    threadKeyFor: async (key) => ((options.indexed ?? true) && thread && key === thread.pullRequestKey ? thread.threadKey : undefined),
    recordOutcome: async (target: OutcomeTarget, outcome) => {
      if (!thread) return { recorded: false };
      const holds = thread.prNumber === target.prNumber && thread.branch === target.branch && (!thread.outcome || thread.outcome.at <= outcome.at);
      if (!holds) return { recorded: false, thread: structuredClone(thread) };
      writes += 1;
      thread.outcome = structuredClone(outcome);
      return { recorded: true, thread: structuredClone(thread) };
    },
    ledgerRow: async (id) => ((options.row ?? true) && id === OPENED_BY ? row : undefined),
    announce: async (r, prNumber, outcome) => {
      announced.push({ row: r, prNumber, outcome });
    },
    log: createLogger('thread-outcome', {}, (line) => {
      const parsed = JSON.parse(line) as { level: string; message: string; workItemId?: string; reason?: string };
      logs.push(parsed);
    }),
  };
  return { deps, logs, announced, writes: () => writes, thread };
}

const recorded = (number = mergedExample.number): Partial<Thread> => ({
  threadKey: THREAD,
  branch: mergedExample.headBranch,
  pullRequestKey: `jamiegeddes/factorial#${number}`,
  prNumber: number,
  prOpenedBy: OPENED_BY,
});

describe('recordPullRequestClosed', () => {
  it('records a merge on the thread and announces it for the item that opened the pull request', async () => {
    const h = harness(recorded());
    await recordPullRequestClosed(mergedExample, h.deps);
    assert.deepEqual(h.thread?.outcome, { state: 'merged', at: mergedExample.closedAt, by: 'JamieGeddes', mergeCommit: mergedExample.mergeCommit });
    assert.equal(h.announced.length, 1);
    assert.equal(h.announced[0]?.row.workItemId, OPENED_BY);
    assert.equal(h.announced[0]?.prNumber, 220);
    assert.ok(h.logs.some((l) => l.message === 'outcome recorded' && l.workItemId === OPENED_BY));
  });

  it('records a close without merging', async () => {
    const h = harness({ ...recorded(closedExample.number), branch: closedExample.headBranch });
    await recordPullRequestClosed(closedExample, h.deps);
    assert.deepEqual(h.thread?.outcome, { state: 'closed', at: closedExample.closedAt, by: 'JamieGeddes' });
  });

  it('sets the same values again for a repeated delivery', async () => {
    const h = harness(recorded());
    await recordPullRequestClosed(mergedExample, h.deps);
    const after = structuredClone(h.thread);
    await recordPullRequestClosed(mergedExample, h.deps);
    assert.deepEqual(h.thread, after);
    assert.deepEqual(h.announced[1], h.announced[0]);
  });

  it('keeps a later close over an earlier one delivered late', async () => {
    const h = harness({ ...recorded(), outcome: { state: 'merged', at: '2026-11-01T00:00:00Z', by: 'someone' } });
    await recordPullRequestClosed(mergedExample, h.deps);
    assert.equal(h.thread?.outcome?.by, 'someone');
    assert.equal(h.announced.length, 0);
    assert.match(h.logs.at(-1)?.reason ?? '', /later close/);
  });

  it('ignores a pull request no thread records', async () => {
    const h = harness(recorded(), { indexed: false });
    await recordPullRequestClosed(mergedExample, h.deps);
    assert.equal(h.writes(), 0);
    assert.equal(h.logs.at(-1)?.message, 'ignored: no thread records the pull request');
  });

  it('changes nothing when the thread is for another branch', async () => {
    const h = harness({ ...recorded(), branch: 'factorial/00000000-0000-4000-8000-000000000000' });
    await recordPullRequestClosed(mergedExample, h.deps);
    assert.equal(h.writes(), 0);
    assert.match(h.logs.at(-1)?.reason ?? '', /branch/);
  });

  it('ignores an event that does not fit the contract', async () => {
    const h = harness(recorded());
    await recordPullRequestClosed({ ...mergedExample, title: 'text' }, h.deps);
    assert.equal(h.writes(), 0);
    assert.equal(h.logs.at(-1)?.message, 'event invalid; ignored');
  });

  it('keeps the outcome when the opening item has no row, and says so', async () => {
    const h = harness(recorded(), { row: false });
    await recordPullRequestClosed(mergedExample, h.deps);
    assert.equal(h.thread?.outcome?.state, 'merged');
    assert.equal(h.announced.length, 0);
    assert.equal(h.logs.at(-1)?.level, 'error');
  });
});

describe('the outcome', () => {
  it('builds a schema-valid progress event', () => {
    const row: LedgerRow = { workItemId: OPENED_BY, workItem: { source: { type: 'github-issue', url: 'https://github.com/o/r/issues/1' }, repository: mergedExample.repository } };
    const outcome = outcomeOf(mergedExample);
    const event = progressEvent(row, 'PullRequest', outcome.state, outcome.at, { pullRequest: { number: 220, by: outcome.by } });
    assert.deepEqual(progressEventErrors(event), []);
  });

  it('is written only on the thread that records the pull request from its branch, and never before a later close', () => {
    const input = outcomeUpdate('factorial-threads', { threadKey: THREAD, prNumber: 220, branch: mergedExample.headBranch }, outcomeOf(mergedExample));
    assert.equal(input.ConditionExpression, 'prNumber = :number AND #branch = :branch AND (attribute_not_exists(#outcome) OR #outcome.#at <= :at)');
    assert.equal(input.UpdateExpression, 'SET #outcome = :outcome, updatedAt = :now');
    assert.equal(input.ReturnValuesOnConditionCheckFailure, 'ALL_OLD');
    assert.equal(input.ExpressionAttributeValues?.[':at'], mergedExample.closedAt);
  });
});
