import assert from 'node:assert/strict';
import { test } from 'node:test';

import { artefactsUrl, branchUrl, commitUrl, executionUrl, issueUrl, pullRequestUrl } from './links.ts';

const repo = { owner: 'JamieGeddes', name: 'factorial' };

test('GitHub links are built from repository fields, and only from valid ones', () => {
  assert.equal(issueUrl(repo, 5), 'https://github.com/JamieGeddes/factorial/issues/5');
  assert.equal(pullRequestUrl(repo, 6), 'https://github.com/JamieGeddes/factorial/pull/6');
  assert.equal(commitUrl(repo, '5e26e4e'), 'https://github.com/JamieGeddes/factorial/commit/5e26e4e');
  assert.equal(issueUrl({ owner: 'evil.com/x', name: 'y' }, 5), undefined);
  assert.equal(issueUrl({ owner: 'a', name: '..' }, 5), undefined);
  assert.equal(pullRequestUrl(repo, -1), undefined);
  assert.equal(commitUrl(repo, 'javascript:alert(1)'), undefined);
  assert.equal(branchUrl(repo, 'factorial/../x'), undefined);
});

test('console links accept only well-formed identifiers', () => {
  assert.match(executionUrl('arn:aws:states:eu-west-1:123456789012:execution:factorial-work:a_b') ?? '', /^https:\/\/eu-west-1\.console\.aws\.amazon\.com\/states\//);
  assert.equal(executionUrl('javascript:alert(1)'), undefined);
  assert.match(artefactsUrl('factorial-work-artefacts-1', '7f93ccb0-d53d-11f1-8851-ff488f20a8b2/1/') ?? '', /prefix=7f93ccb0/);
  assert.equal(artefactsUrl('b', '../'), undefined);
});
