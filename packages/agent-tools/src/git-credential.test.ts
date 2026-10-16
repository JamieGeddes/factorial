import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseGitCredentialInput, shouldAnswer } from './git-credential.ts';

describe('git credential helper protocol', () => {
  it('parses key=value lines and ignores blanks', () => {
    const parsed = parseGitCredentialInput('protocol=https\nhost=github.com\npath=JamieGeddes/factorial.git\n\n');
    assert.deepEqual(parsed, { protocol: 'https', host: 'github.com', path: 'JamieGeddes/factorial.git' });
  });

  it('keeps values that themselves contain an equals sign', () => {
    assert.deepEqual(parseGitCredentialInput('path=a=b'), { path: 'a=b' });
  });

  it('answers only for https github.com', () => {
    assert.equal(shouldAnswer({ protocol: 'https', host: 'github.com' }), true);
    assert.equal(shouldAnswer({ protocol: 'http', host: 'github.com' }), false);
    assert.equal(shouldAnswer({ protocol: 'https', host: 'evil.example.com' }), false);
    assert.equal(shouldAnswer({ protocol: 'https', host: 'github.com.evil.example.com' }), false);
    assert.equal(shouldAnswer({}), false);
  });
});
