import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertCommitSha, assertGitHubName, assertGitHubToken, assertUuid, gitAuthHeader, redactSecrets, shellQuote } from './shell.ts';

describe('gitAuthHeader', () => {
  it('encodes the token as basic auth for x-access-token', () => {
    const header = gitAuthHeader('ghs_abc');
    assert.equal(header, `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_abc').toString('base64')}`);
  });
});

describe('redactSecrets', () => {
  it('masks tokens in URLs, bare tokens and auth headers', () => {
    const text = 'fatal: https://x-access-token:ghs_SECRET@github.com/o/r.git and ghs_SECRET2 and AUTHORIZATION: basic eC1hY2Nlc3M=';
    const out = redactSecrets(text);
    assert.doesNotMatch(out, /SECRET/);
    assert.doesNotMatch(out, /eC1hY2Nlc3M/);
    assert.match(out, /x-access-token:\*\*\*@github\.com/);
    assert.match(out, /ghs_\*\*\*/);
  });

  it('leaves ordinary text alone', () => {
    assert.equal(redactSecrets('git exited 128: not a repository'), 'git exited 128: not a repository');
  });
});

describe('assertCommitSha', () => {
  it('accepts 40 hex characters only', () => {
    assert.equal(assertCommitSha('a'.repeat(40), 'sha'), 'a'.repeat(40));
    assert.throws(() => assertCommitSha('abc', 'sha'), /not a commit sha/);
    assert.throws(() => assertCommitSha('A'.repeat(40), 'sha'), /not a commit sha/);
  });
});

describe('shellQuote', () => {
  it('wraps in single quotes and escapes embedded single quotes', () => {
    assert.equal(shellQuote('plain'), `'plain'`);
    assert.equal(shellQuote(`it's`), `'it'\\''s'`);
    assert.equal(shellQuote('$(rm -rf /) `x` "y"'), `'$(rm -rf /) \`x\` "y"'`);
  });
});

describe('GitHub name validation', () => {
  it('accepts normal owner and repository names', () => {
    assert.equal(assertGitHubName('JamieGeddes', 'owner'), 'JamieGeddes');
    assert.equal(assertGitHubName('factorial', 'repo'), 'factorial');
    assert.equal(assertGitHubName('my.repo-name_1', 'repo'), 'my.repo-name_1');
  });

  it('rejects shell metacharacters, leading punctuation and .git suffixes', () => {
    for (const bad of ['a b', 'x;rm', '-lead', '.hidden', 'repo.git', '', 'a/b', 'é']) {
      assert.throws(() => assertGitHubName(bad, 'repo'), /not a valid GitHub name/);
    }
  });
});

describe('token and uuid validation', () => {
  it('accepts installation tokens and rejects anything else', () => {
    assert.equal(assertGitHubToken('ghs_AbC123_xyz'), 'ghs_AbC123_xyz');
    assert.throws(() => assertGitHubToken('ghs_abc@evil'), /unexpected format/);
  });

  it('accepts lower-case UUIDs only', () => {
    assert.equal(assertUuid('7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c', 'id'), '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c');
    assert.throws(() => assertUuid('not-a-uuid', 'id'), /not a UUID/);
    assert.throws(() => assertUuid('7F3C1D2E-5B7A-4C7E-9A1B-2D3E4F5A6B7C', 'id'), /not a UUID/);
  });
});
