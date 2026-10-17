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
  const identity = { name: 'factorial-x[bot]', email: '12345+factorial-x[bot]@users.noreply.github.com' };
  const params = {
    owner: 'JamieGeddes',
    name: 'factorial',
    branch: 'factorial/abc',
    baseBranch: 'main',
    headSha: sha,
    token: TOKEN,
    bundleBase64: 'QUJD',
    identity,
  };

  it('imports the bundle into a pristine clone, verifies the head and pushes exactly that commit', () => {
    const script = cleanRoomPushScript(params);
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    assert.match(script, /printf '%s' 'QUJD' \| base64 -d > incoming\.bundle/);
    assert.match(script, new RegExp(`clone --quiet --bare --filter=blob:none 'https://github\\.com/JamieGeddes/factorial\\.git' repo\\.git`));
    assert.match(script, /fetch --quiet \.\.\/incoming\.bundle HEAD/);
    // clone, bundle import (lazy blob fetch from origin) and push all authenticate
    assert.equal(script.split('http.extraHeader=').length - 1, 3);
    assert.match(script, new RegExp(`test "\\$\\(git rev-parse FETCH_HEAD\\)" = '${sha}'`));
    assert.match(script, /push --quiet origin "\$new:refs\/heads\/factorial\/abc"/);
    assert.match(script, /echo "\$new"$/);
    assert.match(script, new RegExp(`http\\.extraHeader='AUTHORIZATION: basic ${basic}'`));
    assert.doesNotMatch(script, /ghs_t/);
    assert.doesNotMatch(script, /x-access-token:ghs/);
    assert.ok(script.split('core.hooksPath=/dev/null').length >= 4, 'every git call that could run hooks disables them');
  });

  it('re-creates every commit with the App identity, keeping trees, messages and author dates', () => {
    const script = cleanRoomPushScript(params);
    assert.match(script, /base=\$\(git merge-base 'refs\/heads\/main' FETCH_HEAD\)/);
    assert.match(script, /test -z "\$\(git rev-list --merges "\$base\.\.FETCH_HEAD"\)"/);
    assert.match(script, /for c in \$\(git rev-list --reverse "\$base\.\.FETCH_HEAD"\); do/);
    assert.match(script, /GIT_AUTHOR_NAME='factorial-x\[bot\]' GIT_AUTHOR_EMAIL='12345\+factorial-x\[bot\]@users\.noreply\.github\.com' GIT_COMMITTER_NAME='factorial-x\[bot\]' GIT_COMMITTER_EMAIL='12345\+factorial-x\[bot\]@users\.noreply\.github\.com'/);
    assert.match(script, /GIT_AUTHOR_DATE="\$\(git log -1 --format=%aI "\$c"\)" git commit-tree "\$c\^\{tree\}" -p "\$new"/);
    // the rewrite happens after the head check and before the push
    assert.ok(script.indexOf('rev-parse FETCH_HEAD') < script.indexOf('commit-tree'));
    assert.ok(script.indexOf('commit-tree') < script.indexOf('push --quiet'));
  });

  it('rejects an identity or branch that could break out of the shell command', () => {
    assert.throws(() => cleanRoomPushScript({ ...params, identity: { ...identity, name: "x'; rm -rf /" } }), /unexpected format/);
    assert.throws(() => cleanRoomPushScript({ ...params, identity: { ...identity, email: 'a b@c' } }), /unexpected format/);
    assert.throws(() => cleanRoomPushScript({ ...params, baseBranch: 'main;ls' }), /not a valid branch name/);
    assert.throws(() => cleanRoomPushScript({ ...params, branch: '../x' }), /not a valid branch name/);
  });

  it('rejects bad names and shas before building anything', () => {
    assert.throws(() => cleanRoomPushScript({ ...params, owner: 'bad owner' }), /not a valid GitHub name/);
    assert.throws(() => cleanRoomPushScript({ ...params, headSha: 'short' }), /not a commit sha/);
  });
});
