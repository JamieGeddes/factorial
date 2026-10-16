import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { verifyGitHubSignature } from './signature.ts';

const secret = 'correct horse battery staple';
const body = Buffer.from('{"action":"labeled"}');
const good = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('verifyGitHubSignature', () => {
  it('accepts a correct signature', () => {
    assert.equal(verifyGitHubSignature(secret, body, good), true);
  });

  it('accepts an upper-case hex digest', () => {
    assert.equal(verifyGitHubSignature(secret, body, good.toUpperCase().replace('SHA256=', 'sha256=')), true);
  });

  it('rejects a missing header', () => {
    assert.equal(verifyGitHubSignature(secret, body, undefined), false);
  });

  it('rejects the wrong algorithm prefix', () => {
    assert.equal(verifyGitHubSignature(secret, body, good.replace('sha256=', 'sha1=')), false);
  });

  it('rejects a tampered body', () => {
    assert.equal(verifyGitHubSignature(secret, Buffer.from('{"action":"opened"}'), good), false);
  });

  it('rejects the wrong secret', () => {
    assert.equal(verifyGitHubSignature('other', body, good), false);
  });

  it('rejects a digest of the wrong length without throwing', () => {
    assert.equal(verifyGitHubSignature(secret, body, 'sha256=abc'), false);
  });
});
