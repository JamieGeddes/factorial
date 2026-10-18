import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decidePrEvent, mentionsBot, MAX_AUTOMATIC_CHECKS_REWORKS } from './pr-event.ts';

const botLogin = 'my-factorial[bot]';
const owner = { id: 6577672, login: 'JamieGeddes', type: 'User' };
const stranger = { id: 9999, login: 'stranger', type: 'User' };
const botSender = { id: 42, login: 'my-factorial[bot]', type: 'Bot' };
const allowedUserIds = new Set([owner.id]);

const pr = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  html_url: 'https://github.com/JamieGeddes/factorial/pull/7',
  head: { ref: 'factorial/146b11c0', sha: 'a'.repeat(40) },
  base: { ref: 'main' },
  user: { login: 'my-factorial[bot]', type: 'Bot' },
  ...overrides,
});

const repo = { name: 'factorial', owner: { login: 'JamieGeddes' } };
const options = { botLogin, allowedUserIds };

describe('decidePrEvent: pull_request_review', () => {
  const payload = (overrides: Record<string, unknown> = {}) => ({
    action: 'submitted',
    review: { state: 'changes_requested', body: 'Please rework this.' },
    pull_request: pr(),
    repository: repo,
    sender: owner,
    ...overrides,
  });

  it('maps a submitted changes_requested review to rework-review', () => {
    const decision = decidePrEvent('pull_request_review', payload(), options);
    assert.equal(decision.kind, 'rework-review');
    if (decision.kind !== 'rework-review') return;
    assert.equal(decision.pullRequest.number, 7);
    assert.deepEqual(decision.comment, { author: 'JamieGeddes', body: 'Please rework this.' });
  });

  it('ignores an approved review', () => {
    const decision = decidePrEvent('pull_request_review', payload({ review: { state: 'approved', body: 'Nice' } }), options);
    assert.equal(decision.kind, 'ignore');
  });

  it('ignores an edited or dismissed review action', () => {
    assert.equal(decidePrEvent('pull_request_review', payload({ action: 'edited' }), options).kind, 'ignore');
    assert.equal(decidePrEvent('pull_request_review', payload({ action: 'dismissed' }), options).kind, 'ignore');
  });
});

describe('decidePrEvent: pull_request_review_comment', () => {
  const payload = (overrides: Record<string, unknown> = {}) => ({
    action: 'created',
    comment: { body: 'hey @my-factorial[bot], please fix this', path: 'src/x.ts', line: 12 },
    pull_request: pr(),
    repository: repo,
    sender: owner,
    ...overrides,
  });

  it('maps a comment mentioning the bot login to rework-review, with file and line', () => {
    const decision = decidePrEvent('pull_request_review_comment', payload(), options);
    assert.equal(decision.kind, 'rework-review');
    if (decision.kind !== 'rework-review') return;
    assert.deepEqual(decision.comment, {
      author: 'JamieGeddes',
      body: 'hey @my-factorial[bot], please fix this',
      path: 'src/x.ts',
      line: 12,
    });
  });

  it('maps a comment starting with /factorial to rework-review', () => {
    const decision = decidePrEvent(
      'pull_request_review_comment',
      payload({ comment: { body: '/factorial please rework', path: 'src/x.ts' } }),
      options,
    );
    assert.equal(decision.kind, 'rework-review');
  });

  it('ignores a plain comment', () => {
    const decision = decidePrEvent('pull_request_review_comment', payload({ comment: { body: 'just a note' } }), options);
    assert.equal(decision.kind, 'ignore');
  });
});

describe('decidePrEvent: issue_comment', () => {
  const payload = (overrides: Record<string, unknown> = {}) => ({
    action: 'created',
    issue: { number: 7, html_url: 'https://github.com/JamieGeddes/factorial/pull/7' },
    comment: { body: '/factorial rework this please' },
    repository: repo,
    sender: owner,
    ...overrides,
  });
  const enriched = (overrides: Record<string, unknown> = {}) =>
    payload({ ...overrides, pull_request: pr() });

  it('maps a /factorial comment on the PR to rework-review', () => {
    const decision = decidePrEvent('issue_comment', enriched(), options);
    assert.equal(decision.kind, 'rework-review');
  });

  it('maps a comment mentioning the bot login to rework-review', () => {
    const decision = decidePrEvent('issue_comment', enriched({ comment: { body: 'cc @my-factorial[bot]' } }), options);
    assert.equal(decision.kind, 'rework-review');
  });

  it('ignores a plain comment', () => {
    const decision = decidePrEvent('issue_comment', enriched({ comment: { body: 'looks fine to me' } }), options);
    assert.equal(decision.kind, 'ignore');
  });

  it('ignores a comment that is not on a pull request (no PR record)', () => {
    const decision = decidePrEvent('issue_comment', payload(), options);
    assert.equal(decision.kind, 'ignore');
  });

  it('ignores edited comments', () => {
    const decision = decidePrEvent('issue_comment', enriched({ action: 'edited' }), options);
    assert.equal(decision.kind, 'ignore');
  });
});

describe('decidePrEvent: check_suite and workflow_run', () => {
  const checkSuite = (overrides: Record<string, unknown> = {}) => ({
    action: 'completed',
    check_suite: { conclusion: 'failure', pull_requests: [pr()] },
    repository: repo,
    ...overrides,
  });
  const workflowRun = (overrides: Record<string, unknown> = {}) => ({
    action: 'completed',
    workflow_run: { conclusion: 'failure', pull_requests: [pr()] },
    repository: repo,
    ...overrides,
  });

  it('maps a failed check_suite on the PR head to rework-checks-failed', () => {
    const decision = decidePrEvent('check_suite', checkSuite(), options);
    assert.equal(decision.kind, 'rework-checks-failed');
    if (decision.kind !== 'rework-checks-failed') return;
    assert.equal(decision.pullRequest.number, 7);
    assert.equal(decision.headSha, 'a'.repeat(40));
  });

  it('maps a failed workflow_run on the PR head to rework-checks-failed', () => {
    const decision = decidePrEvent('workflow_run', workflowRun(), options);
    assert.equal(decision.kind, 'rework-checks-failed');
  });

  it('ignores a successful check_suite', () => {
    assert.equal(decidePrEvent('check_suite', checkSuite({ check_suite: { conclusion: 'success', pull_requests: [pr()] } }), options).kind, 'ignore');
  });

  it('ignores a successful workflow_run', () => {
    assert.equal(decidePrEvent('workflow_run', workflowRun({ workflow_run: { conclusion: 'success', pull_requests: [pr()] } }), options).kind, 'ignore');
  });

  it('ignores a requested (not completed) check_suite', () => {
    assert.equal(decidePrEvent('check_suite', checkSuite({ action: 'requested' }), options).kind, 'ignore');
  });

  it('ignores a failure on a commit with no Factorial PR', () => {
    const other = pr({ number: 8, head: { ref: 'feature/x', sha: 'b'.repeat(40) }, user: { login: 'someone', type: 'User' } });
    assert.equal(decidePrEvent('check_suite', checkSuite({ check_suite: { conclusion: 'failure', pull_requests: [other] } }), options).kind, 'ignore');
  });
});

describe('decidePrEvent: anything else', () => {
  it('ignores unknown events', () => {
    assert.equal(decidePrEvent('push', { zen: 'Design for failure.' }, options).kind, 'ignore');
  });

  it('ignores an empty event name', () => {
    assert.equal(decidePrEvent('', {}, options).kind, 'ignore');
  });
});

describe('guards', () => {
  const review = (overrides: Record<string, unknown> = {}) => ({
    action: 'submitted',
    review: { state: 'changes_requested', body: 'Rework.' },
    pull_request: pr(),
    repository: repo,
    sender: owner,
    ...overrides,
  });
  const comment = (overrides: Record<string, unknown> = {}) => ({
    action: 'created',
    comment: { body: '/factorial rework' },
    pull_request: pr(),
    repository: repo,
    sender: owner,
    ...overrides,
  });

  it('ignores PRs not on a factorial/* branch', () => {
    const decision = decidePrEvent(
      'pull_request_review',
      review({ pull_request: pr({ head: { ref: 'feature/x', sha: 'a'.repeat(40) } }) }),
      options,
    );
    assert.equal(decision.kind, 'ignore');
  });

  it('ignores PRs not opened by a GitHub App (the Factorial App)', () => {
    const decision = decidePrEvent(
      'pull_request_review',
      review({ pull_request: pr({ user: { login: 'someone', type: 'User' } }) }),
      options,
    );
    assert.equal(decision.kind, 'ignore');
  });

  it('ignores events from untrusted users', () => {
    assert.equal(decidePrEvent('pull_request_review', review({ sender: stranger }), options).kind, 'ignore');
    assert.equal(decidePrEvent('pull_request_review_comment', comment({ sender: stranger }), options).kind, 'ignore');
  });

  it('ignores comments from bots, including Factorial own', () => {
    const otherBot = { id: 43, login: 'other-app[bot]', type: 'Bot' };
    assert.equal(decidePrEvent('pull_request_review_comment', comment({ sender: botSender }), options).kind, 'ignore');
    assert.equal(decidePrEvent('pull_request_review_comment', comment({ sender: otherBot }), options).kind, 'ignore');
    assert.equal(decidePrEvent('pull_request_review', review({ sender: botSender }), options).kind, 'ignore');
  });

  it('caps automatic checks-failed reworks at two', () => {
    assert.equal(MAX_AUTOMATIC_CHECKS_REWORKS, 2);
  });
});

describe('mentionsBot', () => {
  it('matches the bot login with an @ and without', () => {
    assert.equal(mentionsBot('cc @my-factorial[bot]', botLogin), true);
    assert.equal(mentionsBot('my-factorial[bot] please', botLogin), true);
  });

  it('does not match a longer login that merely contains the bot login', () => {
    // GitHub logins can contain a hyphen, so these are (hypothetical) distinct
    // logins, not mentions; a boundary character is required on both sides.
    assert.equal(mentionsBot('hello my-factorial[bot]2', botLogin), false);
    assert.equal(mentionsBot('hello xmy-factorial[bot]', botLogin), false);
    assert.equal(mentionsBot('no mention here', botLogin), false);
  });
});
