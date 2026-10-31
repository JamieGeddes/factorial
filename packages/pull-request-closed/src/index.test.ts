import assert from 'node:assert/strict';
import { test } from 'node:test';

import closed from '../../../contracts/pull-request-closed/v1/examples/closed.json' with { type: 'json' };
import merged from '../../../contracts/pull-request-closed/v1/examples/merged.json' with { type: 'json' };

import { validatePullRequestClosed } from './index.ts';

test('accepts the examples', () => {
  for (const example of [merged, closed]) assert.deepEqual(validatePullRequestClosed(example), { ok: true, value: example });
});

test('a merge says when, and only a merge has a merge commit', () => {
  const { mergedAt: _mergedAt, ...noTime } = merged;
  assert.equal(validatePullRequestClosed(noTime).ok, false);
  assert.equal(validatePullRequestClosed({ ...closed, mergeCommit: merged.mergeCommit }).ok, false);
  assert.equal(validatePullRequestClosed({ ...closed, mergedAt: merged.mergedAt }).ok, false);
});

test('refuses a branch that is not a Factorial work branch', () => {
  assert.equal(validatePullRequestClosed({ ...closed, headBranch: 'main' }).ok, false);
  assert.equal(validatePullRequestClosed({ ...closed, headBranch: 'factorial/../main' }).ok, false);
});

test('refuses content and unknown fields', () => {
  const result = validatePullRequestClosed({ ...closed, title: 'Add a thing', body: 'text' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.errors.join(' '), /additional properties/);
});

test('refuses a missing fact', () => {
  for (const field of ['repository', 'number', 'url', 'headBranch', 'merged', 'closedAt', 'by'] as const) {
    const { [field]: _omitted, ...rest } = closed;
    assert.equal(validatePullRequestClosed(rest).ok, false, field);
  }
});
