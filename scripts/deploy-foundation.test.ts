import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readEnvValue } from './deploy-foundation.ts';

describe('readEnvValue', () => {
  const key = 'FACTORIAL_BOOTSTRAP_BUCKET';

  it('reads a plain, exported or quoted value', () => {
    assert.equal(readEnvValue(`${key}=my-bucket\n`, key), 'my-bucket');
    assert.equal(readEnvValue(`export ${key}=my-bucket`, key), 'my-bucket');
    assert.equal(readEnvValue(`${key}="my-bucket"`, key), 'my-bucket');
    assert.equal(readEnvValue(`${key}='my-bucket'`, key), 'my-bucket');
  });

  it('ignores comments, other keys and keys that only share a prefix', () => {
    const text = [`# ${key}=commented`, `OTHER=x`, `${key}_OLD=old`, `${key}=current`].join('\n');
    assert.equal(readEnvValue(text, key), 'current');
  });

  it('treats a missing or empty value as unset', () => {
    assert.equal(readEnvValue('OTHER=x', key), undefined);
    assert.equal(readEnvValue(`${key}=`, key), undefined);
    assert.equal(readEnvValue(`${key}=""`, key), undefined);
  });

  it('does not evaluate shell in the value', () => {
    assert.equal(readEnvValue(`${key}=$(whoami)`, key), '$(whoami)');
  });
});
