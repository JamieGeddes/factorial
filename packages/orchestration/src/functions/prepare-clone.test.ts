import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { cloneScript } from './prepare.ts';

// The clone script runs in the Linux session; this runs it with bash against a local repository.
const linux = process.platform === 'linux';

const TOKEN = `ghs_${'Z9'.repeat(18)}`;
const URL = 'https://github.com/o/n.git';
const ON_MAIN = 'factorial/11111111-1111-4111-8111-111111111111'; // branched from main
const ON_RELEASE = 'factorial/22222222-2222-4222-8222-222222222222'; // branched from release/1

describe('cloneScript, run with bash', { skip: !linux }, () => {
  let root = '';
  let bare = '';
  const sha: Record<string, string> = {};

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
  const session = (...args: string[]): string => git(join(root, 'repo'), ...args);

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'prepare-clone-'));
    bare = join(root, 'remote.git');
    const work = join(root, 'work');
    git(root, 'init', '--quiet', '--bare', '-b', 'main', bare);
    git(root, 'init', '--quiet', '-b', 'main', work);
    const commit = (file: string, text: string): string => {
      writeFileSync(join(work, file), text);
      git(work, 'add', '.');
      git(work, 'commit', '--quiet', '-m', `${file}: ${text}`);
      return git(work, 'rev-parse', 'HEAD');
    };
    sha.main1 = commit('a.txt', 'one\n');
    sha.main2 = commit('a.txt', 'two\n');
    git(work, 'checkout', '--quiet', '-b', 'release/1', sha.main1);
    sha.release = commit('release.txt', 'release\n');
    git(work, 'checkout', '--quiet', '-b', ON_RELEASE);
    commit('r1.txt', '1\n');
    sha.onRelease = commit('r2.txt', '2\n');
    git(work, 'checkout', '--quiet', '-b', ON_MAIN, 'main');
    sha.onMain = commit('m.txt', 'work\n');
    git(work, 'checkout', '--quiet', '-b', 'other/unrelated', 'main');
    commit('other.txt', 'other\n');
    git(work, 'push', '--quiet', bare, '--all');
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  /** Run the real script with /workspace pointed at the temporary directory and the GitHub URL at the local repository. */
  const run = (params: Partial<Parameters<typeof cloneScript>[0]>) => {
    const script = cloneScript({ owner: 'o', name: 'n', branch: ON_MAIN, token: TOKEN, mode: 'create', ...params });
    const result = spawnSync('bash', ['-c', script.replaceAll('/workspace', root)], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`,
        GIT_CONFIG_VALUE_0: URL,
      },
    });
    return { ...result, lines: result.stdout.trim().split('\n') };
  };
  const remoteRefs = (): string[] => session('for-each-ref', '--format=%(refname)', 'refs/remotes/origin').split('\n');

  it('a new item gets the default branch only, a new work branch on its tip, and origin/HEAD', () => {
    const r = run({});
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.lines.slice(-2), [sha.main2, 'main']);
    assert.equal(session('symbolic-ref', 'refs/remotes/origin/HEAD'), 'refs/remotes/origin/main');
    assert.equal(session('symbolic-ref', '--short', 'HEAD'), ON_MAIN);
    assert.equal(session('rev-parse', 'HEAD'), sha.main2);
    assert.deepEqual(remoteRefs(), ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    assert.equal(session('for-each-ref', '--format=%(upstream)', 'refs/heads'), ''); // no upstream, as from a local main
    assert.equal(session('log', '--format=%H', 'origin/HEAD..HEAD'), '');
    assert.equal(session('diff', 'origin/main...HEAD'), '');
  });

  it('a new item pinned to a commit starts its branch there', () => {
    const r = run({ at: sha.main1 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.lines.slice(-2), [sha.main1, 'main']);
    assert.equal(session('symbolic-ref', '--short', 'HEAD'), ON_MAIN);
    assert.equal(session('rev-list', '--count', 'origin/HEAD..HEAD'), '0');
  });

  it('an existing branch is checked out at the start commit, with the default branch and the merge base', () => {
    const r = run({ mode: 'checkout', at: sha.onMain });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.lines.slice(-2), [sha.onMain, 'main']);
    assert.equal(session('rev-parse', 'HEAD'), sha.onMain);
    assert.equal(session('symbolic-ref', '--short', 'HEAD'), ON_MAIN);
    assert.equal(session('rev-parse', `refs/heads/${ON_MAIN}`), sha.onMain);
    assert.deepEqual(remoteRefs(), ['refs/remotes/origin/HEAD', `refs/remotes/origin/${ON_MAIN}`, 'refs/remotes/origin/main']);
    assert.equal(session('merge-base', 'origin/main', 'HEAD'), sha.main2);
    assert.match(session('diff', '--stat', 'origin/main...HEAD'), /m\.txt/);
    assert.equal(session('log', '--format=%H', 'origin/HEAD..HEAD'), sha.onMain);
  });

  it('an existing branch that is not at the start commit fails', () => {
    const r = run({ mode: 'checkout', at: sha.main1 });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /is not at the expected commit/);
  });

  it('a rework on a non-default base has that base, the default branch, the work branch and the merge base', () => {
    const r = run({ mode: 'checkout', branch: ON_RELEASE, baseBranch: 'release/1', at: sha.onRelease });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.lines.slice(-2), [sha.onRelease, 'main']);
    assert.deepEqual(remoteRefs(), [
      'refs/remotes/origin/HEAD',
      `refs/remotes/origin/${ON_RELEASE}`,
      'refs/remotes/origin/main',
      'refs/remotes/origin/release/1',
    ]);
    assert.equal(session('symbolic-ref', 'refs/remotes/origin/HEAD'), 'refs/remotes/origin/main');
    assert.equal(session('merge-base', 'origin/release/1', 'HEAD'), sha.release);
    assert.match(session('diff', '--stat', 'origin/release/1...HEAD'), /r1\.txt[\s\S]*r2\.txt/);
    assert.equal(session('show', 'origin/release/1:release.txt'), 'release');
  });

  it('a rework whose base is the default branch fetches it once', () => {
    const r = run({ mode: 'checkout', baseBranch: 'main' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(remoteRefs(), ['refs/remotes/origin/HEAD', `refs/remotes/origin/${ON_MAIN}`, 'refs/remotes/origin/main']);
  });

  it('checking out a branch that is not on the remote fails', () => {
    const r = run({ mode: 'checkout', branch: 'factorial/33333333-3333-4333-8333-333333333333' });
    assert.notEqual(r.status, 0);
  });

  it('leaves the token in no file of the session and no configuration', () => {
    const r = run({ mode: 'checkout', branch: ON_RELEASE, baseBranch: 'release/1' });
    assert.equal(r.status, 0, r.stderr);
    const base64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
    const all = files(join(root, 'repo', '.git'));
    assert.ok(all.length > 0);
    for (const file of all) {
      if (!statSync(file).isFile()) continue;
      const content = readFileSync(file).toString('latin1');
      assert.ok(!content.includes(TOKEN) && !content.includes(base64), file);
    }
    assert.doesNotMatch(session('config', '--list'), /extraheader/i);
    assert.equal(r.stdout.includes(TOKEN) || r.stderr.includes(TOKEN), false);
  });
});
