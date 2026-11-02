import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_MINOR_GAP, minorGap, parseFixtureOutput, parseGitVersion, violations } from './check-git-version.ts';

const output = (version: string, ...lines: string[]) => parseFixtureOutput([`git version ${version}`, ...lines].join('\n') + '\n');

describe('parseGitVersion', () => {
  it('reads the version from git --version', () => {
    assert.deepEqual(parseGitVersion('git version 2.47.3'), { major: 2, minor: 47, patch: 3, text: 'git version 2.47.3' });
  });

  it('ignores a vendor suffix', () => {
    assert.equal(parseGitVersion('git version 2.39.5 (Apple Git-154)').minor, 39);
  });

  it('rejects anything else', () => {
    assert.throws(() => parseGitVersion('sh: git: not found'), /Not a git version line/);
  });
});

describe('minorGap', () => {
  it('counts minor versions behind, and negative when ahead', () => {
    assert.equal(minorGap(parseGitVersion('git version 2.56.0'), parseGitVersion('git version 2.47.3')), 9);
    assert.equal(minorGap(parseGitVersion('git version 2.47.0'), parseGitVersion('git version 2.50.1')), -3);
  });

  it('treats an older major version as infinitely behind', () => {
    assert.equal(minorGap(parseGitVersion('git version 3.0.0'), parseGitVersion('git version 2.99.0')), Infinity);
  });
});

describe('violations', () => {
  const ci = output('2.56.0', 'aI utc: 2026-10-30T12:00:00Z');

  it('passes an image within the gap whose fixture output matches', () => {
    assert.deepEqual(violations('agent-runtime', ci, output('2.47.3', 'aI utc: 2026-10-30T12:00:00Z')), []);
  });

  it('passes an image ahead of CI', () => {
    assert.deepEqual(violations('agent-runtime', ci, output('2.60.0', 'aI utc: 2026-10-30T12:00:00Z')), []);
  });

  it('fails the bookworm image on the UTC %aI line (#274)', () => {
    const found = violations('agent-runtime', ci, output('2.39.5', 'aI utc: 2026-10-30T12:00:00+00:00'));
    assert.equal(found.length, 2);
    assert.match(found[0]!, /17 minor versions behind/);
    assert.match(found[1]!, /fixture line 1 differs/);
  });

  it('fails an image more than the agreed gap behind, and passes one exactly at it', () => {
    const line = 'aI utc: 2026-10-30T12:00:00Z';
    assert.equal(violations('x', ci, output(`2.${56 - MAX_MINOR_GAP - 1}.0`, line)).length, 1);
    assert.deepEqual(violations('x', ci, output(`2.${56 - MAX_MINOR_GAP}.0`, line)), []);
  });

  it('fails when an image prints fewer fixture lines than CI', () => {
    assert.match(violations('x', output('2.56.0', 'a', 'b'), output('2.56.0', 'a'))[0]!, /line 2 differs/);
  });
});
