import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bundleScript, cleanRoomPushScript, inspectScript, parseInspection } from './collect.ts';

const TOKEN = `ghs_${'t'.repeat(36)}`;

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

describe('agent-session scripts carry no credentials', () => {
  it('inspects with hooks disabled and commits leftovers first', () => {
    const script = inspectScript('main');
    assert.match(script, /GIT_CONFIG_NOSYSTEM=1/);
    assert.match(script, /git rev-list --count 'origin\/main'\.\.HEAD/);
    assert.ok(script.indexOf('add -A') < script.indexOf('git rev-list'));
    assert.doesNotMatch(script, /AUTHORIZATION|x-access-token|ghs_/);
  });

  it('bundles only the new commits, pins the head and caps the size', () => {
    const script = bundleScript('main', sha);
    assert.match(script, new RegExp(`test "\\$\\(git rev-parse HEAD\\)" = '${sha}'`));
    assert.match(script, /bundle create \/tmp\/factorial\.bundle 'origin\/main'\.\.HEAD/);
    assert.match(script, /bundle too large/);
    assert.match(script, /base64 -w0 \/tmp\/factorial\.bundle$/m);
    assert.doesNotMatch(script, /AUTHORIZATION|x-access-token|ghs_/);
    assert.throws(() => bundleScript('main', 'nope'), /not a commit sha/);
  });
});

describe('cleanRoomPushScript', () => {
  const params = { owner: 'JamieGeddes', name: 'factorial', branch: 'factorial/abc', headSha: sha, token: TOKEN, bundleBase64: 'QUJD' };

  it('imports the bundle into a pristine clone, verifies the head and pushes exactly that commit', () => {
    const script = cleanRoomPushScript(params);
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    assert.match(script, /printf '%s' 'QUJD' \| base64 -d > incoming\.bundle/);
    assert.match(script, new RegExp(`clone --quiet --bare --filter=blob:none 'https://github\\.com/JamieGeddes/factorial\\.git' repo\\.git`));
    assert.match(script, /fetch --quiet \.\.\/incoming\.bundle HEAD/);
    // clone, bundle import (lazy blob fetch from origin) and push all authenticate
    assert.equal(script.split('http.extraHeader=').length - 1, 3);
    assert.match(script, new RegExp(`test "\\$\\(git rev-parse FETCH_HEAD\\)" = '${sha}'`));
    assert.match(script, new RegExp(`push --quiet origin '${sha}:refs/heads/factorial/abc'`));
    assert.match(script, new RegExp(`http\\.extraHeader='AUTHORIZATION: basic ${basic}'`));
    assert.doesNotMatch(script, /ghs_t/);
    assert.doesNotMatch(script, /x-access-token:ghs/);
    assert.ok(script.split('core.hooksPath=/dev/null').length >= 4, 'every git call that could run hooks disables them');
  });

  it('rejects bad names and shas before building anything', () => {
    assert.throws(() => cleanRoomPushScript({ ...params, owner: 'bad owner' }), /not a valid GitHub name/);
    assert.throws(() => cleanRoomPushScript({ ...params, headSha: 'short' }), /not a commit sha/);
  });
});
