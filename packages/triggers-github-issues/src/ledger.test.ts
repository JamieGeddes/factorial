import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { automaticChecksReworks, mayStartAutomaticChecksRework, resolveChecksFailed } from './ledger.ts';

const item = (workItemId: string, cause?: 'review' | 'checks-failed') => ({ workItemId, ...(cause === undefined ? {} : { cause }) });

describe('the checks-failed cap', () => {
  const decision = {
    kind: 'rework-checks-failed',
    pullRequest: {
      number: 7,
      html_url: 'https://github.com/JamieGeddes/factorial/pull/7',
      head: { ref: 'factorial/abc', sha: 'a'.repeat(40) },
      base: { ref: 'main' },
      user: { login: 'my-factorial[bot]', type: 'Bot' },
    },
    headSha: 'a'.repeat(40),
  } as const;

  it('counts zero automatic reworks when the PR has no ledger rows', () => {
    assert.equal(automaticChecksReworks([]), 0);
  });

  it('counts the leading run of checks-failed items', () => {
    const rows = [item('4', 'checks-failed'), item('3', 'checks-failed'), item('2', 'review'), item('1', 'checks-failed')];
    assert.equal(automaticChecksReworks(rows), 2);
  });

  it('a review item in between resets the run', () => {
    const rows = [item('4', 'review'), item('3', 'checks-failed'), item('2', 'checks-failed')];
    assert.equal(automaticChecksReworks(rows), 0);
  });

  it('allows the first and second automatic rework, blocks the third', () => {
    assert.equal(mayStartAutomaticChecksRework([]), true);
    assert.equal(mayStartAutomaticChecksRework([item('1', 'checks-failed')]), true);
    assert.equal(mayStartAutomaticChecksRework([item('2', 'checks-failed'), item('1', 'checks-failed')]), false);
  });

  it('resolves to the newest WorkItem as previousWorkItemId while under the cap', () => {
    const rows = [item('2', 'checks-failed'), item('1', 'checks-failed')];
    const resolved = resolveChecksFailed(decision, rows);
    // Two automatic reworks already ran: capped.
    assert.equal(resolved.kind, 'ignore');
  });

  it('resolves to ok with the previous WorkItem under the cap', () => {
    const rows = [item('2', 'review'), item('1', 'checks-failed')];
    const resolved = resolveChecksFailed(decision, rows);
    assert.deepEqual(resolved, { kind: 'ok', previousWorkItemId: '2' });
  });

  it('ignores a PR with no ledger rows: fail closed', () => {
    assert.equal(resolveChecksFailed(decision, []).kind, 'ignore');
  });
});
