import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { inspectScript, parseInspection, pushScript } from './collect.ts';

const SECTION = '\n===FACTORIAL-SECTION===\n';
const sha = 'a'.repeat(40);

describe('parseInspection', () => {
  it('extracts the commit count, head sha and summary', () => {
    const out = `3\n${SECTION}${sha}\n${SECTION}# Summary\n\nDid the thing.\n`;
    assert.deepEqual(parseInspection(out), { commitCount: 3, headSha: sha, summary: '# Summary\n\nDid the thing.' });
  });

  it('tolerates a missing summary', () => {
    assert.deepEqual(parseInspection(`0\n${SECTION}${sha}\n${SECTION}`), { commitCount: 0, headSha: sha, summary: '' });
  });

  it('rejects malformed output', () => {
    assert.throws(() => parseInspection('garbage'), /Could not parse/);
    assert.throws(() => parseInspection(`x${SECTION}${sha}${SECTION}`), /Could not parse/);
  });
});

describe('scripts', () => {
  it('inspects relative to the quoted base branch and commits leftovers first', () => {
    const script = inspectScript('main');
    assert.match(script, /git rev-list --count 'origin\/main'\.\.HEAD/);
    assert.ok(script.indexOf('git add -A') < script.indexOf('git rev-list'));
  });

  it('pushes the branch with the token in the URL and nothing else', () => {
    const script = pushScript({ owner: 'JamieGeddes', name: 'factorial', branch: 'factorial/abc', token: 'ghs_t' });
    assert.match(script, /git push --quiet 'https:\/\/x-access-token:ghs_t@github\.com\/JamieGeddes\/factorial\.git' 'HEAD:refs\/heads\/factorial\/abc'/);
    assert.throws(() => pushScript({ owner: 'bad owner', name: 'factorial', branch: 'b', token: 't' }), /not a valid GitHub name/);
  });
});
