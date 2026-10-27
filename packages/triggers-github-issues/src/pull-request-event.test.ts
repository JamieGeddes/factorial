import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BadPayloadError } from './issue-event.ts';
import type { WorkItem } from '@factorial/workitem';

import { addressedRequest, decidePullRequestEvent, type PullRequestDecideOptions, type PullRequestDecision } from './pull-request-event.ts';

/** The work item a decision emits; fails the test when it ignores the event. */
function work(decision: PullRequestDecision): WorkItem {
  if (decision.kind === 'ignore') assert.fail(`expected a work item, got ignore: ${decision.reason}`);
  return decision.workItem;
}

const SLUG = 'factorial-x';
const BOT = { id: 900, login: `${SLUG}[bot]`, type: 'Bot' };
const owner = { id: 1, login: 'owner', type: 'User' };
const stranger = { id: 2, login: 'stranger', type: 'User' };
const ORIGINAL = '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c';
const BRANCH = `factorial/${ORIGINAL}`;
const HEAD = 'a'.repeat(40);
const DELIVERY = '72d3162e-cc78-11e3-81ab-4c9367dc0958';
const repository = { id: 42, name: 'factorial', owner: { login: 'JamieGeddes' }, default_branch: 'main' };

const options: PullRequestDecideOptions = { appSlug: SLUG, allowedUserIds: new Set([1]), deliveryId: DELIVERY, now: new Date('2026-10-26T10:00:00Z') };

const pullRequest = (overrides: Record<string, unknown> = {}) => ({
  number: 26,
  title: 'Add a thing',
  html_url: 'https://github.com/JamieGeddes/factorial/pull/26',
  state: 'open',
  user: BOT,
  head: { ref: BRANCH, sha: HEAD, repo: { id: 42 } },
  base: { ref: 'main', repo: { id: 42 } },
  ...overrides,
});

const review = (overrides: Record<string, unknown> = {}, pr: Record<string, unknown> = {}) => ({
  action: 'submitted',
  review: {
    id: 77,
    state: 'changes_requested',
    body: 'Please split the handler.',
    html_url: 'https://github.com/JamieGeddes/factorial/pull/26#pullrequestreview-77',
    user: owner,
  },
  pull_request: pullRequest(pr),
  repository,
  sender: owner,
  ...overrides,
});

const reviewComment = (body: string, overrides: Record<string, unknown> = {}) => ({
  action: 'created',
  comment: {
    id: 5,
    body,
    path: 'src/a.ts',
    line: 12,
    html_url: 'https://github.com/JamieGeddes/factorial/pull/26#discussion_r5',
    user: owner,
  },
  pull_request: pullRequest(),
  repository,
  sender: owner,
  ...overrides,
});

const issueComment = (body: string, issue: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) => ({
  action: 'created',
  issue: {
    number: 26,
    title: 'Add a thing',
    html_url: 'https://github.com/JamieGeddes/factorial/pull/26',
    state: 'open',
    body: 'No Run details are read.',
    user: BOT,
    pull_request: { html_url: 'https://github.com/JamieGeddes/factorial/pull/26' },
    ...issue,
  },
  comment: { id: 9, body, html_url: 'https://github.com/JamieGeddes/factorial/pull/26#issuecomment-9', user: owner },
  repository,
  sender: owner,
  ...overrides,
});

const workflowRun = (run: Record<string, unknown> = {}) => ({
  action: 'completed',
  workflow_run: {
    id: 3,
    name: 'CI',
    html_url: 'https://github.com/JamieGeddes/factorial/actions/runs/3',
    event: 'pull_request',
    conclusion: 'failure',
    head_branch: BRANCH,
    head_sha: HEAD,
    head_repository: { id: 42 },
    pull_requests: [{ number: 26, head: { ref: BRANCH, sha: HEAD }, base: { ref: 'main' } }],
    actor: BOT,
    ...run,
  },
  repository,
  sender: BOT,
});

function ignored(event: string, payload: unknown, reason: RegExp, opts = options): void {
  const decision = decidePullRequestEvent(event, payload, opts);
  if (decision.kind !== 'ignore') assert.fail(`expected ignore, got a work item`);
  assert.match(decision.reason, reason);
}

/** What every item in reply to pull request #26 shares. */
function inReplyTo26(workItem: WorkItem): void {
  assert.equal(workItem.schemaVersion, 2);
  assert.equal(workItem.id, DELIVERY);
  assert.deepEqual(workItem.repository, { provider: 'github', owner: 'JamieGeddes', name: 'factorial' });
  assert.deepEqual(workItem.inReplyTo, { kind: 'pull-request', number: 26 });
}

describe('decidePullRequestEvent: a review requesting changes', () => {
  it('records the review, its text as the body, in reply to the pull request', () => {
    const workItem = work(decidePullRequestEvent('pull_request_review', review(), options));
    inReplyTo26(workItem);
    assert.deepEqual(workItem.source, { type: 'github-pull-request-review', id: '77', url: 'https://github.com/JamieGeddes/factorial/pull/26#pullrequestreview-77' });
    assert.equal(workItem.title, 'Review of #26: Add a thing');
    assert.equal(workItem.body, 'Please split the handler.');
    assert.equal(workItem.requestedBy, 'owner');
  });

  it('still counts with an empty body, leaving the points to the inline comments', () => {
    const workItem = work(decidePullRequestEvent('pull_request_review', review({ review: { ...review().review, body: null } }), options));
    assert.equal(workItem.body, '');
  });

  it('ignores approvals, plain comments and other actions', () => {
    ignored('pull_request_review', review({ review: { ...review().review, state: 'approved' } }), /state "approved"/);
    ignored('pull_request_review', review({ review: { ...review().review, state: 'commented' } }), /state "commented"/);
    ignored('pull_request_review', review({ action: 'edited' }), /action "edited"/);
  });
});

describe('decidePullRequestEvent: an inline review comment', () => {
  it('records the request after the mention, naming the comment so Prepare can fetch its file and line', () => {
    const workItem = work(decidePullRequestEvent('pull_request_review_comment', reviewComment(`@${SLUG} rename this to b`), options));
    inReplyTo26(workItem);
    assert.deepEqual(workItem.source, { type: 'github-pull-request-review-comment', id: '5', url: 'https://github.com/JamieGeddes/factorial/pull/26#discussion_r5' });
    assert.equal(workItem.title, 'Comment on #26: Add a thing');
    assert.equal(workItem.body, 'rename this to b');
  });

  it('ignores a comment that does not start with the mention, or has nothing after it', () => {
    ignored('pull_request_review_comment', reviewComment('looks fine'), /does not address Factorial/);
    ignored('pull_request_review_comment', reviewComment(`thanks @${SLUG} rename this`), /does not address Factorial/);
    ignored('pull_request_review_comment', reviewComment(`/factorial rename this`), /does not address Factorial/);
    ignored('pull_request_review_comment', reviewComment(`@${SLUG}`), /without a request/);
  });

  it('ignores edits', () => {
    ignored('pull_request_review_comment', reviewComment(`@${SLUG} rename`, { action: 'edited' }), /action "edited"/);
  });
});

describe('decidePullRequestEvent: a conversation comment', () => {
  it('records the request without reading a branch: Intake takes it from the thread', () => {
    const workItem = work(decidePullRequestEvent('issue_comment', issueComment(`@${SLUG}: please add a test`), options));
    inReplyTo26(workItem);
    assert.deepEqual(workItem.source, { type: 'github-pull-request-comment', id: '9', url: 'https://github.com/JamieGeddes/factorial/pull/26#issuecomment-9' });
    assert.equal(workItem.body, 'please add a test');
  });

  it('ignores comments on issues and closed pull requests', () => {
    ignored('issue_comment', issueComment(`@${SLUG} go`, { pull_request: undefined }), /on an issue, not a pull request/);
    ignored('issue_comment', issueComment(`@${SLUG} go`, { state: 'closed' }), /is closed/);
  });
});

describe('decidePullRequestEvent: a failed workflow run', () => {
  it('records the run that failed on the pull request head', () => {
    const workItem = work(decidePullRequestEvent('workflow_run', workflowRun(), options));
    inReplyTo26(workItem);
    assert.deepEqual(workItem.source, { type: 'github-workflow-run', id: '3', url: 'https://github.com/JamieGeddes/factorial/actions/runs/3' });
    assert.equal(workItem.title, 'The workflow "CI" failed on #26');
    assert.equal(workItem.body, `The workflow "CI" failed on ${HEAD.slice(0, 12)}: https://github.com/JamieGeddes/factorial/actions/runs/3`);
    assert.equal(workItem.requestedBy, BOT.login);
  });

  it('needs the App or a trusted person to have caused the run, never another bot', () => {
    assert.equal(decidePullRequestEvent('workflow_run', workflowRun({ actor: owner, triggering_actor: owner }), options).kind, 'emit');
    ignored('workflow_run', workflowRun({ actor: stranger }), /caused by untrusted user "stranger"/);
    ignored('workflow_run', workflowRun({ triggering_actor: stranger }), /caused by untrusted user "stranger"/);
    ignored('workflow_run', workflowRun({ actor: { id: 1, login: 'other[bot]', type: 'Bot' } }), /caused by untrusted bot/);
  });

  it('counts a failure on push as well as on the pull request', () => {
    assert.equal(decidePullRequestEvent('workflow_run', workflowRun({ event: 'push' }), options).kind, 'emit');
  });

  it('ignores success, other events, other branches, forks and stale heads', () => {
    ignored('workflow_run', workflowRun({ conclusion: 'success' }), /concluding "success"/);
    ignored('workflow_run', workflowRun({ conclusion: null }), /concluding "none"/);
    ignored('workflow_run', workflowRun({ event: 'workflow_dispatch' }), /for "workflow_dispatch"/);
    ignored('workflow_run', workflowRun({ head_branch: 'main', pull_requests: [] }), /not on a Factorial work branch/);
    ignored('workflow_run', workflowRun({ head_repository: { id: 99 } }), /another repository/);
    ignored('workflow_run', workflowRun({ pull_requests: [] }), /not on the head of an open pull request/);
    ignored('workflow_run', workflowRun({ head_sha: 'b'.repeat(40) }), /not on the head of an open pull request/);
    ignored('workflow_run', { ...workflowRun(), action: 'requested' }, /action "requested"/);
  });
});

describe('decidePullRequestEvent: guards', () => {
  it('ignores untrusted people, whoever wrote the comment or sent the event', () => {
    ignored('pull_request_review', review({ sender: stranger, review: { ...review().review, user: stranger } }), /untrusted user "stranger"/);
    ignored('pull_request_review_comment', reviewComment(`@${SLUG} go`, { sender: stranger, comment: { ...reviewComment('').comment, body: `@${SLUG} go`, user: stranger } }), /untrusted user/);
    ignored('issue_comment', issueComment(`@${SLUG} go`, {}, { sender: stranger, comment: { id: 9, body: `@${SLUG} go`, html_url: 'h', user: stranger } }), /untrusted user/);
  });

  it('never counts a bot, Factorial included, even if its id were trusted', () => {
    const trustingBot = { ...options, allowedUserIds: new Set([1, 900]) };
    ignored('issue_comment', issueComment(`@${SLUG} go`, {}, { sender: BOT, comment: { id: 9, body: `@${SLUG} go`, html_url: 'h', user: BOT } }), /ignored bot/, trustingBot);
  });

  it('acts only on open pull requests Factorial opened from its own work branch in this repository', () => {
    ignored('pull_request_review', review({}, { state: 'closed' }), /is closed/);
    ignored('pull_request_review', review({}, { user: owner }), /not opened by Factorial/);
    ignored('pull_request_review', review({}, { head: { ref: 'feature/x', sha: HEAD, repo: { id: 42 } } }), /not on a Factorial work branch/);
    ignored('pull_request_review', review({}, { head: { ref: BRANCH, sha: HEAD, repo: { id: 99 } } }), /from another repository/);
    ignored('issue_comment', issueComment(`@${SLUG} go`, { user: owner }), /not opened by Factorial/);
  });

  it('ignores events it does not handle, and rejects payloads that do not fit', () => {
    ignored('push', {}, /ignored event "push"/);
    assert.throws(() => decidePullRequestEvent('pull_request_review', { action: 'submitted', review: {} }, options), BadPayloadError);
  });

  it('uses a fresh id when the delivery id is not a UUID', () => {
    assert.notEqual(work(decidePullRequestEvent('pull_request_review', review(), { ...options, deliveryId: 'nope' })).id, 'nope');
  });

  it('caps the body at the contract limit; Intake caps a point at 8,000 characters', () => {
    const workItem = work(decidePullRequestEvent('pull_request_review_comment', reviewComment(`@${SLUG} ${'x'.repeat(70_000)}`), options));
    assert.equal(workItem.body.length, 65_536);
  });
});

describe('addressedRequest', () => {
  it('reads the request after a leading mention, case-insensitively', () => {
    assert.equal(addressedRequest(`@${SLUG} do it`, SLUG), 'do it');
    assert.equal(addressedRequest(`  @Factorial-X, do it`, SLUG), 'do it');
    assert.equal(addressedRequest(`@${SLUG}\n\nmulti\nline`, SLUG), 'multi\nline');
  });

  it('does not match a longer login that starts with the slug', () => {
    assert.equal(addressedRequest(`@${SLUG}-other do it`, SLUG), undefined);
    assert.equal(addressedRequest(`@${SLUG}x do it`, SLUG), undefined);
  });
});
