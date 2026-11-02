/**
 * The clean-room push end to end, against a local bare repository standing
 * in for GitHub: real git, a real bundle, a real push.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { cleanRoomPush, githubRemote, type CleanRoomPush } from './clean-room.ts';
import { gitAuthHeader } from './shell.ts';

const TOKEN = `ghs_${'t'.repeat(36)}`;
const BOT = { name: 'factorial-x[bot]', email: '12345+factorial-x[bot]@users.noreply.github.com' };
const AGENT_ENV = {
  GIT_AUTHOR_NAME: 'Agent',
  GIT_AUTHOR_EMAIL: 'agent@factorial.invalid',
  GIT_COMMITTER_NAME: 'Agent',
  GIT_COMMITTER_EMAIL: 'agent@factorial.invalid',
};

let root: string;
let origin: string;
let work: string;
let remoteUrl: string;

/** Git for the fixtures, with none of the developer's own configuration (signing, hooks). */
function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...AGENT_ENV, ...env },
  }).trim();
}

/** Commit a file in the agent's clone, with a fixed author date. */
function commit(file: string, content: string, message: string, date: string): string {
  writeFileSync(path.join(work, file), content);
  git(work, ['add', file]);
  git(work, ['commit', '--quiet', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(work, ['rev-parse', 'HEAD']);
}

/** Commit everything in the agent's clone (renames, deletions, mode changes included), with a fixed author date. */
function commitAll(message: string, date: string): string {
  git(work, ['add', '-A']);
  git(work, ['commit', '--quiet', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(work, ['rev-parse', 'HEAD']);
}

/** The agent's commits from `base`, as the session's bundle script exports them. */
function bundle(base: string): Buffer {
  const file = path.join(root, 'out.bundle');
  git(work, ['bundle', 'create', '--quiet', file, `${base}..HEAD`]);
  return readFileSync(file);
}

function originRef(branch: string): string | undefined {
  try {
    return git(origin, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  } catch {
    return undefined;
  }
}

function params(overrides: Partial<CleanRoomPush>): CleanRoomPush {
  return {
    remoteUrl,
    branch: 'factorial/item',
    baseCommit: '',
    headSha: git(work, ['rev-parse', 'HEAD']),
    existingBranch: false,
    token: TOKEN,
    bundle: Buffer.alloc(0),
    identity: BOT,
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'factorial-clean-room-test-'));
  origin = path.join(root, 'origin.git');
  work = path.join(root, 'work');
  // file:// so the clone goes through upload-pack and the blob filter and
  // its lazy fetch are exercised as they are against GitHub.
  remoteUrl = `file://${origin}`;
  git(root, ['init', '--quiet', '--bare', '--initial-branch=main', origin]);
  git(origin, ['config', 'uploadpack.allowFilter', 'true']);
  git(origin, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  git(root, ['clone', '--quiet', origin, work]);
  git(work, ['checkout', '--quiet', '-b', 'main']);
  commit('README.md', 'hello\n', 'Initial commit', '2026-10-01T09:00:00+00:00');
  commit('big.txt', 'unchanged content\n'.repeat(1000), 'Add a file the agent leaves alone', '2026-10-01T09:30:00+00:00');
  git(work, ['push', '--quiet', 'origin', 'main']);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('cleanRoomPush', () => {
  it('fast-forwards a new branch with every commit under the App identity and its original author date', async () => {
    const base = git(work, ['rev-parse', 'HEAD']);
    git(work, ['checkout', '--quiet', '-b', 'factorial/item']);
    const first = commit('a.txt', 'one\n', 'First change\n\nWith a body.', '2026-10-30T12:34:56+01:00');
    commit('b.txt', 'two\n', 'Second change', '2026-10-30T13:00:00+01:00');

    const head = await cleanRoomPush(params({ baseCommit: base, bundle: bundle(base) }));

    assert.equal(originRef('factorial/item'), head);
    assert.equal(git(origin, ['rev-list', '--count', `${base}..${head}`]), '2');
    const log = git(origin, ['log', '--reverse', '--format=%an|%ae|%cn|%ce|%aI|%s', `${base}..${head}`]).split('\n');
    assert.deepEqual(log, [
      `${BOT.name}|${BOT.email}|${BOT.name}|${BOT.email}|2026-10-30T12:34:56+01:00|First change`,
      `${BOT.name}|${BOT.email}|${BOT.name}|${BOT.email}|2026-10-30T13:00:00+01:00|Second change`,
    ]);
    // trees and messages are kept exactly; only the identities change
    assert.equal(git(origin, ['rev-parse', `${head}^{tree}`]), git(work, ['rev-parse', 'HEAD^{tree}']));
    assert.equal(git(origin, ['log', '-1', '--format=%B', `${head}~1`]), git(work, ['log', '-1', '--format=%B', first]));
    assert.equal(git(origin, ['rev-parse', `${head}~2`]), base);
    // main is untouched
    assert.equal(originRef('main'), base);
  });

  it('keeps a rename and a deletion, under the App identity', async () => {
    const base = git(work, ['rev-parse', 'HEAD']);
    git(work, ['checkout', '--quiet', '-b', 'factorial/item']);
    git(work, ['mv', 'README.md', 'GUIDE.md']);
    commitAll('Rename the readme', '2026-10-30T12:00:00+00:00');
    git(work, ['rm', '--quiet', 'big.txt']);
    commitAll('Delete the big file', '2026-10-30T13:00:00+00:00');

    const head = await cleanRoomPush(params({ baseCommit: base, bundle: bundle(base) }));

    assert.equal(originRef('factorial/item'), head);
    assert.equal(git(origin, ['rev-parse', `${head}^{tree}`]), git(work, ['rev-parse', 'HEAD^{tree}']));
    const changes = git(origin, ['diff', '--name-status', '-M', base, head]).split('\n').sort();
    assert.deepEqual(changes, ['D\tbig.txt', 'R100\tREADME.md\tGUIDE.md']);
    const authors = git(origin, ['log', '--format=%an|%ae|%cn|%ce', `${base}..${head}`]).split('\n');
    assert.deepEqual(authors, Array(2).fill(`${BOT.name}|${BOT.email}|${BOT.name}|${BOT.email}`));
  });

  it('keeps the executable bit of a new script', async () => {
    const base = git(work, ['rev-parse', 'HEAD']);
    git(work, ['checkout', '--quiet', '-b', 'factorial/item']);
    writeFileSync(path.join(work, 'run.sh'), '#!/bin/sh\necho hi\n');
    chmodSync(path.join(work, 'run.sh'), 0o755);
    commitAll('Add a script', '2026-10-30T12:00:00+01:00');
    assert.match(git(work, ['ls-tree', 'HEAD', 'run.sh']), /^100755 /);

    const head = await cleanRoomPush(params({ baseCommit: base, bundle: bundle(base) }));

    assert.equal(originRef('factorial/item'), head);
    assert.match(git(origin, ['ls-tree', head, 'run.sh']), /^100755 blob [0-9a-f]{40}\trun\.sh$/);
    assert.equal(git(origin, ['rev-parse', `${head}^{tree}`]), git(work, ['rev-parse', 'HEAD^{tree}']));
    assert.equal(
      git(origin, ['log', '-1', '--format=%an|%ae|%cn|%ce|%aI', head]),
      `${BOT.name}|${BOT.email}|${BOT.name}|${BOT.email}|2026-10-30T12:00:00+01:00`,
    );
  });

  it('pushes an edit to a large file the base already has', async () => {
    const base = git(work, ['rev-parse', 'HEAD']);
    git(work, ['checkout', '--quiet', '-b', 'factorial/item']);
    const lines = readFileSync(path.join(work, 'big.txt'), 'utf8').split('\n');
    lines[500] = 'one changed line';
    writeFileSync(path.join(work, 'big.txt'), lines.join('\n'));
    commitAll('Edit one line of the big file', '2026-10-30T12:00:00+01:00');

    const head = await cleanRoomPush(params({ baseCommit: base, bundle: bundle(base) }));

    assert.equal(originRef('factorial/item'), head);
    assert.equal(git(origin, ['show', `${head}:big.txt`]), lines.join('\n').trim());
    assert.equal(git(origin, ['rev-parse', `${head}^{tree}`]), git(work, ['rev-parse', 'HEAD^{tree}']));
    assert.equal(
      git(origin, ['log', '-1', '--format=%an|%ae|%cn|%ce|%aI', head]),
      `${BOT.name}|${BOT.email}|${BOT.name}|${BOT.email}|2026-10-30T12:00:00+01:00`,
    );
  });

  it('pushes a rework onto the existing branch as a fast-forward', async () => {
    const base = git(work, ['rev-parse', 'HEAD']);
    git(work, ['checkout', '--quiet', '-b', 'factorial/item']);
    commit('a.txt', 'one\n', 'First change', '2026-10-30T12:00:00+00:00');
    const firstPush = await cleanRoomPush(params({ baseCommit: base, bundle: bundle(base) }));

    // The rework session is seeded from the pushed branch, as Prepare does.
    git(work, ['fetch', '--quiet', 'origin']);
    git(work, ['reset', '--quiet', '--hard', firstPush]);
    commit('a.txt', 'one, reworked\n', 'Address the review', '2026-10-31T08:00:00+02:00');

    const head = await cleanRoomPush(params({ baseCommit: firstPush, existingBranch: true, bundle: bundle(firstPush) }));

    assert.equal(originRef('factorial/item'), head);
    assert.equal(git(origin, ['rev-parse', `${head}~1`]), firstPush);
    assert.equal(git(origin, ['log', '-1', '--format=%an|%cn|%aI', head]), `${BOT.name}|${BOT.name}|2026-10-31T08:00:00+02:00`);
  });

  it('refuses when the existing branch has moved since the session started, and pushes nothing', async () => {
    const base = git(work, ['rev-parse', 'HEAD']);
    git(work, ['checkout', '--quiet', '-b', 'factorial/item']);
    commit('a.txt', 'one\n', 'First change', '2026-10-30T12:00:00+00:00');
    const started = await cleanRoomPush(params({ baseCommit: base, bundle: bundle(base) }));

    // Someone else moves the branch on.
    const other = path.join(root, 'other');
    git(root, ['clone', '--quiet', '--branch', 'factorial/item', origin, other]);
    writeFileSync(path.join(other, 'c.txt'), 'theirs\n');
    git(other, ['add', 'c.txt']);
    git(other, ['commit', '--quiet', '-m', 'A human commit']);
    git(other, ['push', '--quiet', 'origin', 'factorial/item']);
    const moved = originRef('factorial/item');

    git(work, ['fetch', '--quiet', 'origin']);
    git(work, ['reset', '--quiet', '--hard', started]);
    commit('a.txt', 'two\n', 'Rework', '2026-10-31T08:00:00+00:00');

    await assert.rejects(
      cleanRoomPush(params({ baseCommit: started, existingBranch: true, bundle: bundle(started) })),
      /factorial\/item has moved: expected [0-9a-f]{40}, found [0-9a-f]{40}; nothing was pushed/,
    );
    assert.equal(originRef('factorial/item'), moved);
  });

  it('refuses a new branch that already exists', async () => {
    const base = git(work, ['rev-parse', 'HEAD']);
    git(work, ['push', '--quiet', 'origin', `${base}:refs/heads/factorial/item`]);
    git(work, ['checkout', '--quiet', '-b', 'factorial/item']);
    commit('a.txt', 'one\n', 'First change', '2026-10-30T12:00:00+00:00');

    await assert.rejects(cleanRoomPush(params({ baseCommit: base, bundle: bundle(base) })), /factorial\/item already exists/);
    assert.equal(originRef('factorial/item'), base);
  });

  it('refuses a merge commit, and pushes nothing', async () => {
    const base = git(work, ['rev-parse', 'HEAD']);
    git(work, ['checkout', '--quiet', '-b', 'side']);
    commit('side.txt', 'side\n', 'Side change', '2026-10-30T11:00:00+00:00');
    git(work, ['checkout', '--quiet', 'main']);
    git(work, ['checkout', '--quiet', '-b', 'factorial/item']);
    commit('a.txt', 'one\n', 'First change', '2026-10-30T12:00:00+00:00');
    git(work, ['merge', '--quiet', '--no-ff', '--no-edit', 'side']);

    await assert.rejects(cleanRoomPush(params({ baseCommit: base, bundle: bundle(base) })), /include a merge commit/);
    assert.equal(originRef('factorial/item'), undefined);
  });

  it("refuses a bundle whose head is not the agent's head", async () => {
    const base = git(work, ['rev-parse', 'HEAD']);
    git(work, ['checkout', '--quiet', '-b', 'factorial/item']);
    commit('a.txt', 'one\n', 'First change', '2026-10-30T12:00:00+00:00');

    await assert.rejects(cleanRoomPush(params({ baseCommit: base, headSha: 'e'.repeat(40), bundle: bundle(base) })), /not the agent's head/);
    assert.equal(originRef('factorial/item'), undefined);
  });

  it('refuses a head that does not descend from the base', async () => {
    const base = git(work, ['rev-parse', 'HEAD~1']);
    git(work, ['checkout', '--quiet', '--orphan', 'factorial/item']);
    git(work, ['rm', '--quiet', '-r', '--cached', '.']);
    const unrelated = commit('x.txt', 'x\n', 'Unrelated root', '2026-10-30T12:00:00+00:00');
    const file = path.join(root, 'unrelated.bundle');
    git(work, ['bundle', 'create', '--quiet', file, 'HEAD']);

    await assert.rejects(cleanRoomPush(params({ baseCommit: base, headSha: unrelated, bundle: readFileSync(file) })), /does not descend from/);
    assert.equal(originRef('factorial/item'), undefined);
  });

  it('never puts the token in an error, and leaves no files behind', async () => {
    const workspaces = () => readdirSync(tmpdir()).filter((name) => name.startsWith('factorial-git-')).sort();
    const before = workspaces();
    const error = await cleanRoomPush(params({ remoteUrl: `file://${path.join(root, 'missing.git')}`, baseCommit: 'b'.repeat(40), headSha: 'a'.repeat(40) })).then(
      () => assert.fail('expected the clone to fail'),
      (e: unknown) => e as Error,
    );
    const basic = gitAuthHeader(TOKEN).split(' ').pop() ?? '';
    assert.match(error.message, /^git clone exited \d+: /);
    assert.ok(!error.message.includes(TOKEN));
    assert.ok(!error.message.includes(basic));
    assert.deepEqual(workspaces(), before);
  });

  it('checks its inputs before running anything', async () => {
    await assert.rejects(cleanRoomPush(params({ branch: '../x', baseCommit: 'b'.repeat(40) })), /not a valid branch name/);
    await assert.rejects(cleanRoomPush(params({ baseCommit: 'short' })), /not a commit sha/);
    await assert.rejects(cleanRoomPush(params({ baseCommit: 'b'.repeat(40), identity: { name: 'x\ny', email: 'a@b' } })), /unexpected format/);
    await assert.rejects(cleanRoomPush(params({ baseCommit: 'b'.repeat(40), token: 'not-a-token' })), /unexpected format/);
  });
});

describe('githubRemote', () => {
  it('is the repository on github.com, for valid names only', () => {
    assert.equal(githubRemote('JamieGeddes', 'factorial'), 'https://github.com/JamieGeddes/factorial.git');
    assert.throws(() => githubRemote('bad owner', 'factorial'), /not a valid GitHub name/);
    assert.throws(() => githubRemote('o', 'x.git'), /not a valid GitHub name/);
  });
});
