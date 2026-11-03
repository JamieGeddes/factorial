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

  it("masks the npm mirror's token and the role's AWS credentials, however a check prints them", () => {
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const session = 'IQoJb3JpZ2luX2VjEAEaCWV1LXdlc3QtMSJHMEUCIQ+/=';
    const text = [
      '//factorial-123456789012.d.codeartifact.eu-west-1.amazonaws.com/npm/factorial-npm/:_authToken=eyJ2ZXIiOjEsImlzdSI6MTcwMH0.abc-def_ghi',
      'AWS_ACCESS_KEY_ID=ASIAIOSFODNN7EXAMPLE',
      `AWS_SECRET_ACCESS_KEY=${secret}`,
      `aws_session_token = ${session}`,
      JSON.stringify({ AccessKeyId: 'AKIAIOSFODNN7EXAMPLE', SecretAccessKey: secret, Token: session }),
    ].join('\n');
    for (const out of [redactSecrets(text), redactSecrets(JSON.stringify({ text }))]) {
      assert.doesNotMatch(out, /eyJ2ZXIi|IOSFODNN7EXAMPLE|wJalrXUtnFEMI|IQoJb3JpZ2lu/);
      assert.match(out, /:_authToken=\*\*\*/);
      assert.match(out, /ASIA\*{16}/);
    }
  });

  it('leaves a short or ordinary value after a credential name alone', () => {
    assert.equal(redactSecrets('AWS_SESSION_TOKEN is not set'), 'AWS_SESSION_TOKEN is not set');
    assert.equal(redactSecrets('"Token": "abc"'), '"Token": "abc"');
  });

  it('leaves ordinary text alone', () => {
    assert.equal(redactSecrets('git exited 128: not a repository'), 'git exited 128: not a repository');
  });
});
