import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LEFTOVER_COMMIT_MESSAGE,
  SALVAGE_COMMIT_MESSAGE,
  bundleScript,
  cleanRoomPushScript,
  dependencyScript,
  inspectScript,
  parseInspection,
  touchesWorkflows,
} from './collect.ts';
import { DEPENDENCY_SECTION } from '../lib/dependency-changes.ts';

const TOKEN = `ghs_${'t'.repeat(36)}`;

const SECTION = '\n===FACTORIAL-SECTION===\n';
const sha = 'a'.repeat(40);
const base = 'b'.repeat(40);

describe('parseInspection', () => {
  it('extracts the commit count, head sha, changed paths and summary', () => {
    const out = `3\n${SECTION}${sha}\n${SECTION}README.md\n.github/workflows/ci.yml\n${SECTION}# Summary\n\nDid the thing.\n`;
    assert.deepEqual(parseInspection(out), {
      commitCount: 3,
      headSha: sha,
      changedPaths: ['README.md', '.github/workflows/ci.yml'],
      summary: '# Summary\n\nDid the thing.',
      dependencies: { added: [], removed: [] },
    });
  });

  it('tolerates no changed paths and a missing summary', () => {
    assert.deepEqual(parseInspection(`0\n${SECTION}${sha}\n${SECTION}\n${SECTION}`), {
      commitCount: 0,
      headSha: sha,
      changedPaths: [],
      summary: '',
      dependencies: { added: [], removed: [] },
    });
  });

  it('rejects malformed output', () => {
    assert.throws(() => parseInspection('garbage'), /Could not parse/);
    assert.throws(() => parseInspection(`x${SECTION}${sha}${SECTION}`), /Could not parse/);
  });

  it('parses the dependency section and tolerates it being missing or malformed', () => {
    const deps = Buffer.from(JSON.stringify({ old: { a: '1' }, new: { a: '1', b: '2' }, licences: { b: 'ISC' } })).toString('base64');
    const out = `1\n${SECTION}${sha}\n${SECTION}package.json\n${SECTION}# Summary\n\nDone.\n${SECTION}${DEPENDENCY_SECTION}${deps}`;
    const parsed = parseInspection(out);
    assert.deepEqual(parsed.dependencies, { added: [{ name: 'b', licence: 'ISC' }], removed: [] });
    const noDeps = parseInspection(`1\n${SECTION}${sha}\n${SECTION}\n${SECTION}`);
    assert.deepEqual(noDeps.dependencies, { added: [], removed: [] });
    const bad = parseInspection(`1\n${SECTION}${sha}\n${SECTION}\n${SECTION}${SECTION}${DEPENDENCY_SECTION}!!!`);
    assert.deepEqual(bad.dependencies, { added: [], removed: [] });
  });

  it('returns empty dependency changes when the section is not base64 JSON', () => {
    const parsed = parseInspection(`1\n${SECTION}${sha}\n${SECTION}\n${SECTION}${SECTION}${DEPENDENCY_SECTION}${Buffer.from('[1,2]').toString('base64')}`);
    assert.deepEqual(parsed.dependencies, { added: [], removed: [] });
  });
});

describe('dependencyScript', () => {
  it('appends a section marker after the summary and reads both package.json files and the lockfile licences', () => {
    const script = inspectScript(base);
    assert.ok(script.includes(dependencyScript(base)));
    assert.ok(script.indexOf(dependencyScript(base)) > script.indexOf('summary.md'));
    assert.match(script, /HEAD:package\.json/);
    assert.match(script, /package-lock\.json/);
    assert.match(script, /node_modules\\\//);
  });

  it('is self-contained and never carries credentials', () => {
    assert.doesNotMatch(dependencyScript(base), /AUTHORIZATION|x-access-token|ghs_/);
  });
});

describe('touchesWorkflows', () => {
  it('is true only for files under .github/workflows/', () => {
    assert.equal(touchesWorkflows(['.github/workflows/ci.yml', 'README.md']), true);
    assert.equal(touchesWorkflows(['.github/CODEOWNERS', 'docs/workflows.md', 'packages/x/.github/workflows/y.yml']), false);
    assert.equal(touchesWorkflows([]), false);
  });
});

describe('agent-session scripts carry no credentials', () => {
  it('inspects with hooks disabled and commits leftovers first', () => {
    const script = inspectScript(base);
    assert.match(script, /GIT_CONFIG_NOSYSTEM=1/);
    assert.match(script, new RegExp(`git rev-list --count '${base}'\\.\\.HEAD`));
    assert.ok(script.indexOf('add -A') < script.indexOf('git rev-list'));
    assert.doesNotMatch(script, /AUTHORIZATION|x-access-token|ghs_/);
    assert.ok(script.includes(`commit --quiet -m '${LEFTOVER_COMMIT_MESSAGE}'`));
  });

  it('labels leftovers as saved work in progress after a failed build', () => {
    const script = inspectScript(base, SALVAGE_COMMIT_MESSAGE);
    assert.ok(script.includes(`commit --quiet -m 'Save work in progress after the build failed'`));
  });

  it('bundles only the new commits, pins the head and caps the size', () => {
    const script = bundleScript(base, sha);
    assert.match(script, new RegExp(`test \"\\$\\(git rev-parse HEAD\\)\" = '${sha}'`));
    assert.match(script, new RegExp(`bundle create /tmp/factorial\\.bundle '${base}'\\.\\.HEAD`));
    assert.match(script, /bundle too large/);
    assert.match(script, /base64 -w0 \/tmp\/factorial\.bundle$/m);
    assert.doesNotMatch(script, /AUTHORIZATION|x-access-token|ghs_/);
    assert.throws(() => bundleScript(base, 'nope'), /not a commit sha/);
  });
});

describe('cleanRoomPushScript', () => {
  const identity = { name: 'factorial-x[bot]', email: '12345+factorial-x[bot]@users.noreply.github.com' };
  const params = {
    owner: 'JamieGeddes',
    name: 'factorial',
    branch: 'factorial/abc',
    baseBranch: 'main',
    baseCommit: base,
    headSha: sha,
    existingBranch: true,
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
    assert.match(script, new RegExp(`base='${base}'`));
    assert.match(script, /test -z "\$\(git rev-list --merges "\$base\.\.FETCH_HEAD"\)"/);
    assert.match(script, /for c in \$\(git rev-list --reverse "\$base\.\.FETCH_HEAD"\); do/);
    assert.match(script, /GIT_AUTHOR_NAME='factorial-x\[bot\]' GIT_AUTHOR_EMAIL='12345\+factorial-x\[bot\]@users\.noreply\.github\.com' GIT_COMMITTER_NAME='factorial-x\[bot\]' GIT_COMMITTER_EMAIL='12345\+factorial-x\[bot\]@users\.noreply\.github\.com'/);
    assert.match(script, /GIT_AUTHOR_DATE="\$\(git log -1 --format=%aI "\$c"\)" git commit-tree "\$c\^\{tree\}" -p "\$new"/);
    // the rewrite happens after the head check and before the push
    assert.ok(script.indexOf('rev-parse FETCH_HEAD') < script.indexOf('commit-tree'));
    assert.ok(script.indexOf('commit-tree') < script.indexOf('push --quiet'));
  });

  it('pushes only on top of the branch head the session started from, as a fast-forward', () => {
    const script = cleanRoomPushScript(params);
    // the branch must still point at the base commit; anything else fails
    assert.match(script, new RegExp(`test "\\$\\(git rev-parse --verify --quiet refs/heads/factorial/abc\\)" = '${base}'`));
    // and the agent's head must descend from it, so the push is a fast-forward
    assert.match(script, new RegExp(`git merge-base --is-ancestor '${base}' FETCH_HEAD`));
    // never a force push
    assert.doesNotMatch(script, /--force|-f refs|push -f/);
    // the ancestry check happens before the rewrite and the push
    assert.ok(script.indexOf('merge-base --is-ancestor') < script.indexOf('commit-tree'));
    assert.ok(script.indexOf('merge-base --is-ancestor') < script.indexOf('push --quiet'));
  });

  it('requires a fresh branch not to exist yet, so the push never overwrites one', () => {
    const script = cleanRoomPushScript({ ...params, existingBranch: false });
    assert.match(script, /test -z "\$\(git rev-parse --verify --quiet refs\/heads\/factorial\/abc\)"/);
    assert.doesNotMatch(script, /rev-parse --verify --quiet refs\/heads\/factorial\/abc\)" =/);
    // the agent's head must still descend from the base commit
    assert.match(script, new RegExp(`git merge-base --is-ancestor '${base}' FETCH_HEAD`));
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
