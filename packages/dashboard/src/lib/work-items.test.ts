import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareItems, costOf, matchesFilter, matchesSearch, newestFirst, sourceLabel, SOURCES, summarise } from './work-items.ts';
import type { LedgerRow } from './records.ts';

const NOW = Date.parse('2026-11-01T10:10:00Z');
const base = (fields: Partial<LedgerRow> = {}): LedgerRow => ({
  workItemId: '7f93ccb0-d53d-11f1-8851-ff488f20a8b2',
  createdAt: '2026-11-01T10:00:00Z',
  workItem: { title: 'Do a thing', requestedBy: 'jamie', source: { type: 'github-issue', id: '201', url: 'https://example.invalid' }, repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' } },
  ...fields,
});

test('a row becomes the table row: source, reference, links built by the app, review mean', () => {
  const s = summarise(base({ result: 'pr-opened', prNumber: 226, branch: 'factorial/x', reviewVerdict: 'approve', reviewScores: { a: 4, b: 5 } }), undefined, NOW);
  assert.equal(s.source.label, 'GitHub issue');
  assert.equal(s.source.ref, '#201');
  // The source's own URL is never used: the link is built from the repository fields.
  assert.equal(s.source.url, 'https://github.com/JamieGeddes/factorial/issues/201');
  assert.deepEqual(s.pullRequest, { number: 226, url: 'https://github.com/JamieGeddes/factorial/pull/226' });
  assert.deepEqual(s.review, { verdict: 'approve', mean: 4.5 });
});

test("a pull request's state comes from its thread, and a rework shows its pull request from the start", () => {
  const thread = (fields = {}) => ({ threadKey: 'k', prNumber: 226, ...fields });
  const opened = base({ result: 'pr-opened', prNumber: 226, prUrl: 'https://evil.example/pull/226' });
  assert.deepEqual(summarise(opened, thread(), NOW).pullRequest, { number: 226, url: 'https://github.com/JamieGeddes/factorial/pull/226', state: 'open' });
  assert.equal(summarise(opened, thread({ outcome: { state: 'merged', by: 'jamie', at: '2026-11-01T11:00:00Z' } }), NOW).pullRequest?.state, 'merged');
  assert.equal(summarise(opened, thread({ outcome: { state: 'closed', by: 'jamie', at: '2026-11-01T11:00:00Z' } }), NOW).pullRequest?.state, 'closed');
  // A thread that records another pull request says nothing of this one.
  assert.equal(summarise(opened, thread({ prNumber: 300 }), NOW).pullRequest?.state, undefined);
  assert.equal(summarise(opened, undefined, NOW).pullRequest?.state, undefined);

  const rework = base({ threadKey: 'k', workItem: { title: 't', source: { type: 'github-pull-request-review', id: '9' }, inReplyTo: { kind: 'pull-request', number: 226 }, repository: { owner: 'JamieGeddes', name: 'factorial' } } });
  assert.deepEqual(summarise(rework, thread(), NOW).pullRequest, { number: 226, url: 'https://github.com/JamieGeddes/factorial/pull/226', state: 'open' });
});

test('a rework names its pull request', () => {
  const s = summarise(base({ workItem: { title: 't', source: { type: 'github-pull-request-comment', id: '9' }, inReplyTo: { kind: 'pull-request', number: 189 }, repository: { owner: 'a', name: 'b' } } }), undefined, NOW);
  assert.equal(s.source.label, 'PR comment');
  assert.equal(s.source.ref, 'PR #189');
});

const REPO = { provider: 'github', owner: 'JamieGeddes', name: 'factorial' };
const PR_URL = 'https://github.com/JamieGeddes/factorial/pull/189';
const RECORDED = 'https://evil.example/phish';

test('every registered source type has its label, reference and link built by the app', () => {
  const cases: Record<string, { label: string; ref: string; url: string; workItem?: Record<string, unknown>; reworkOf?: { prNumber: number } }> = {
    'github-issue': { label: 'GitHub issue', ref: '#42', url: 'https://github.com/JamieGeddes/factorial/issues/42' },
    'github-issue-plan': { label: 'Plan for issue', ref: '#42', url: 'https://github.com/JamieGeddes/factorial/issues/42' },
    'github-pull-request': { label: 'Pull request', ref: 'PR #189', url: PR_URL, workItem: { context: { pullRequest: { number: 189 } } } },
    'github-pull-request-review': { label: 'PR review', ref: 'PR #189', url: PR_URL, workItem: { inReplyTo: { kind: 'pull-request', number: 189 } } },
    'github-pull-request-review-comment': { label: 'PR review comment', ref: 'PR #189', url: PR_URL, workItem: { inReplyTo: { kind: 'pull-request', number: 189 } } },
    'github-pull-request-comment': { label: 'PR comment', ref: 'PR #189', url: PR_URL, workItem: { inReplyTo: { kind: 'pull-request', number: 189 } } },
    'github-workflow-run': { label: 'Checks failed', ref: 'PR #189', url: PR_URL, reworkOf: { prNumber: 189 } },
  };
  assert.deepEqual(Object.keys(cases).sort(), Object.keys(SOURCES).sort());
  for (const [type, c] of Object.entries(cases)) {
    const workItem = { title: 't', source: { type, id: '42', url: RECORDED }, repository: REPO, ...c.workItem };
    const s = summarise(base({ workItem, ...(c.reworkOf ? { reworkOf: c.reworkOf } : {}) }), undefined, NOW);
    assert.deepEqual(s.source, { type, label: c.label, ref: c.ref, url: c.url }, type);
    assert.equal(sourceLabel(type), c.label);
  }
});

test('an unknown source type shows its raw type and source id as text, never a link', () => {
  for (const type of ['jira-ticket', 'constructor', '__proto__']) {
    const workItem = { title: 't', source: { type, id: 'OPS-7', url: RECORDED }, repository: REPO, inReplyTo: { kind: 'pull-request', number: 189 } };
    assert.deepEqual(summarise(base({ workItem }), undefined, NOW).source, { type, label: type, ref: 'OPS-7' }, type);
  }
  const missing = summarise(base({ workItem: { title: 't', source: { id: 'x' }, repository: REPO } }), undefined, NOW);
  assert.deepEqual(missing.source, { type: 'unknown', label: 'unknown', ref: 'x' });
});

test('a recorded source.url is never used: no repository, an invalid one, or no number means no link', () => {
  const issue = (repository: { owner: string; name: string } | undefined, id = '42') =>
    summarise(base({ workItem: { title: 't', source: { type: 'github-issue', id, url: RECORDED }, ...(repository ? { repository } : {}) } }), undefined, NOW).source;
  assert.deepEqual(issue(undefined), { type: 'github-issue', label: 'GitHub issue', ref: '#42' });
  assert.deepEqual(issue({ owner: 'a/../b', name: 'c' }), { type: 'github-issue', label: 'GitHub issue', ref: '#42' });
  assert.deepEqual(issue(REPO, 'abc'), { type: 'github-issue', label: 'GitHub issue', ref: '#abc' });
  const comment = summarise(base({ workItem: { title: 't', source: { type: 'github-pull-request-comment', id: '9', url: RECORDED }, repository: REPO } }), undefined, NOW);
  assert.deepEqual(comment.source, { type: 'github-pull-request-comment', label: 'PR comment', ref: '9' });
});

test('a row without a WorkItem is an incomplete record: no source, reference or requester', () => {
  const s = summarise({ workItemId: '7f93ccb0-d53d-11f1-8851-ff488f20a8b2', status: 'failed', savedWork: true }, undefined, NOW);
  assert.equal(s.incomplete, true);
  assert.equal(s.title, 'No WorkItem recorded');
  assert.deepEqual(s.source, { type: '', label: '', ref: '' });
  assert.equal(s.requester, '');
  assert.deepEqual(s.status, { label: 'failed', tone: 'failed', note: 'Written by a stage update; no WorkItem was accepted' });
  assert.equal(matchesFilter(s, 'attention'), true);
  assert.equal(summarise(base(), undefined, NOW).incomplete, undefined);
});

test('cost sums the runs, and the live run while it has no record', () => {
  const stages = { Build: { startedAt: '1', run: { costUsd: 0.5 } }, Review: { startedAt: '2' } };
  assert.equal(costOf(base({ stages })), 0.5);
  assert.equal(costOf(base({ stages, live: { stage: 'review', round: 1, costUsd: 0.25 } })), 0.75);
  assert.equal(costOf(base({ stages, live: { stage: 'build', round: 1, costUsd: 0.25 } })), 0.5);
  assert.equal(costOf(base()), undefined);
});

test('the filters', () => {
  const running = summarise(base({ stages: { Build: { startedAt: '2026-11-01T10:01:00Z' } }, live: { at: '2026-11-01T10:09:50Z' } }), undefined, NOW);
  const stale = summarise(base({ stages: { Build: { startedAt: '2026-11-01T10:01:00Z' } }, live: { at: '2026-11-01T10:05:00Z' } }), undefined, NOW);
  const waiting = summarise(base({ stages: { Test: { startedAt: '2026-11-01T10:01:00Z' } } }), undefined, NOW);
  const done = summarise(base({ result: 'no-changes' }), undefined, NOW);
  const failed = summarise(base({ result: 'invalid-plan' }), undefined, NOW);
  const refused = summarise(base({ result: 'refused' }), undefined, NOW);
  assert.equal(matchesFilter(running, 'running'), true);
  assert.equal(matchesFilter(waiting, 'running'), false);
  assert.equal(matchesFilter(waiting, 'waiting'), true);
  assert.equal(matchesFilter(done, 'finished'), true);
  assert.equal(matchesFilter(failed, 'attention'), true);
  assert.equal(matchesFilter(stale, 'attention'), true);
  assert.equal(matchesFilter(running, 'attention'), false);
  assert.equal(matchesFilter(refused, 'refused'), true);
  assert.equal(refused.stage, 'Intake');
});

test('search covers id, title, branch and pull request', () => {
  const s = summarise(base({ branch: 'factorial/abc', prNumber: 77, result: 'pr-opened' }), undefined, NOW);
  for (const q of ['7f93ccb0', 'a THING', 'factorial/abc', '#77', 'pr #77', '']) assert.equal(matchesSearch(s, q), true, q);
  assert.equal(matchesSearch(s, 'nothing'), false);
});

test('running and waiting first, then newest first', () => {
  const old = summarise(base({ createdAt: '2026-11-01T09:00:00Z', result: 'failed' }), undefined, NOW);
  const recent = summarise(base({ createdAt: '2026-11-01T11:00:00Z', result: 'failed' }), undefined, NOW);
  const running = summarise(base({ createdAt: '2026-11-01T08:00:00Z' }), undefined, NOW);
  assert.deepEqual([old, recent, running].sort(compareItems), [running, recent, old]);
});

test('newest created first, whatever the state, with items that have no creation time last', () => {
  const old = summarise(base({ createdAt: '2026-11-01T09:00:00Z', result: 'failed' }), undefined, NOW);
  const recent = summarise(base({ createdAt: '2026-11-01T11:00:00Z', result: 'failed' }), undefined, NOW);
  const running = summarise(base({ createdAt: '2026-11-01T08:00:00Z' }), undefined, NOW);
  const { createdAt: _omit, ...rest } = base();
  const undated = summarise(rest, undefined, NOW);
  assert.deepEqual([undated, running, old, recent].sort(newestFirst), [recent, old, running, undated]);
});

test('untrusted text loses control and bidirectional characters', () => {
  const s = summarise(base({ workItem: { title: 'a‮b\u0007c', source: { type: 'github-issue', id: '1' } } }), undefined, NOW);
  assert.equal(s.title, 'abc');
});
