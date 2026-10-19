import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { redactSecrets } from './redact.ts';

/** Stateless installation token shape (October 2026): ghs_<app id>_<jwt>, with dots and hyphens. */
const STATELESS_TOKEN = `ghs_1234_${'e'.repeat(36)}.${'p'.repeat(200)}-${'s'.repeat(80)}_x`;

describe('redactSecrets', () => {
  it('masks tokens in URLs, bare tokens and auth headers', () => {
    const text = `fatal: https://x-access-token:ghs_SECRET@github.com/o/r.git and ghs_SECRET2 and ${STATELESS_TOKEN} and AUTHORIZATION: basic eC1hY2Nlc3M=`;
    const out = redactSecrets(text);
    assert.doesNotMatch(out, /SECRET/);
    assert.doesNotMatch(out, /eC1hY2Nlc3M/);
    assert.match(out, /x-access-token:\*\*\*@github\.com/);
    assert.match(out, /ghs_\*\*\*/);
    assert.doesNotMatch(out, /pppp|ssss/);
  });

  it('masks tokens after a newline or a colour code once text is JSON-encoded', () => {
    const token = `ghs_${'A'.repeat(36)}`;
    for (const text of [`line\n${token}`, `\u001b[0m${token}`, `\u001b[1;31m${token}`, `tab\t${token}`]) {
      const out = redactSecrets(JSON.stringify({ text }));
      assert.doesNotMatch(out, /AAAA/, JSON.stringify(text));
      assert.match(out, /ghs_\*\*\*/);
      assert.doesNotThrow(() => JSON.parse(out));
    }
  });

  it('masks a token straight after a colour sequence in raw text', () => {
    assert.equal(redactSecrets(`\u001b[32mghs_${'A'.repeat(36)}`), '\u001b[32mghs_***');
  });

  it('does not mask a token-like suffix inside a longer word', () => {
    assert.equal(redactSecrets('laughs_loudly'), 'laughs_loudly');
  });

  it('leaves ordinary text alone', () => {
    assert.equal(redactSecrets('git exited 128: not a repository'), 'git exited 128: not a repository');
  });
});
