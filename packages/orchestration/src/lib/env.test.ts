import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { requireEnv } from './env.ts';

const NAME = 'FACTORIAL_TEST_REQUIRE_ENV_VAR';

describe('requireEnv', () => {
  const original = process.env[NAME];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[NAME];
    } else {
      process.env[NAME] = original;
    }
  });

  it('returns the value of a set variable', () => {
    process.env[NAME] = 'some-value';
    assert.equal(requireEnv(NAME), 'some-value');
  });

  it('throws when the variable is unset', () => {
    delete process.env[NAME];
    assert.throws(() => requireEnv(NAME), { message: `Missing required environment variable ${NAME}` });
  });

  it('throws when the variable is an empty string', () => {
    process.env[NAME] = '';
    assert.throws(() => requireEnv(NAME), { message: `Missing required environment variable ${NAME}` });
  });
});
