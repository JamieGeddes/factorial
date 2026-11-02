import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { withGitWorkspace } from './git.ts';
import {
  bundleRepository,
  parseDefaultBranch,
  parseSeedOutput,
  repoSeedScript,
  seedRepository,
  sessionBranches,
  type RepoRefs,
  type SeedRepositoryDeps,
} from './repo-seed.ts';
import type { CommandResult, SessionTarget } from './session.ts';

const WORK = 'factorial/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c';
const URL = 'https://factorial-transfer-123.s3.eu-west-1.amazonaws.com/k/repo.bundle?X-Amz-Signature=abc&X-Amz-Expires=300';

describe('repoSeedScript', () => {
  const params = { owner: 'JamieGeddes', name: 'factorial', branch: WORK, mode: 'create' as const, defaultBranch: 'main', bundleUrl: URL };

  it('fetches from the downloaded bundle only, never from origin, and holds no token', () => {
    const script = repoSeedScript(params);
    assert.match(script, /^set -euo pipefail$/m);
    assert.match(script, /GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=\/dev\/null/);
    assert.match(script, /^git init --quiet \/workspace\/repo$/m);
    assert.match(script, /remote add origin 'https:\/\/github\.com\/JamieGeddes\/factorial\.git'/);
    assert.match(script, /^curl -fsS --retry 3 -o "\$seed_dir\/repo\.bundle" 'https:\/\/factorial-transfer/m);
    assert.match(script, /^git bundle verify --quiet "\$seed_dir\/repo\.bundle"$/m);
    assert.match(script, /^GIT_REFLOG_ACTION='fetch from bundle' git fetch --quiet --no-tags --no-write-fetch-head "\$seed_dir\/repo\.bundle" '\+refs\/heads\/main:refs\/remotes\/origin\/main'$/m);
    assert.doesNotMatch(script, /ls-remote|fetch (?:--\S+ )*origin\b|\bclone\b|--filter|extraHeader|AUTHORIZATION|ghs_|--force/i);
    assert.match(script, /git checkout --quiet --no-track -b 'factorial\/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c' 'origin\/main'/);
  });

  it('keeps the bundle in a directory only root can read, removed however the script ends, and the URL on the download alone', () => {
    const script = repoSeedScript(params);
    assert.match(script, /^seed_dir=\$\(mktemp -d \/tmp\/factorial-seed\.XXXXXX\)$/m);
    assert.match(script, /^trap 'rm -rf "\$seed_dir"' EXIT$/m);
    assert.ok(script.indexOf('rm -rf "$seed_dir"\n') < script.indexOf('git rev-parse HEAD'));
    const withUrl = script.split('\n').filter((line) => line.includes('X-Amz-Signature'));
    assert.equal(withUrl.length, 1);
    assert.match(withUrl[0] ?? '', /^curl /);
    // nothing is exported but the hardened git settings, so the URL reaches no environment
    assert.deepEqual(script.split('\n').filter((line) => line.startsWith('export')), [script.split('\n')[1]]);
  });

  it('fetches the work branch only when it is checked out, and a rework base branch only when given and not the default', () => {
    const work = `'+refs/heads/${WORK}:refs/remotes/origin/${WORK}'`;
    assert.ok(!repoSeedScript(params).includes(work));
    assert.ok(repoSeedScript({ ...params, mode: 'checkout' }).includes(work));
    const release = repoSeedScript({ ...params, mode: 'checkout', baseBranch: 'release/1' });
    assert.match(release, /"\$seed_dir\/repo\.bundle" '\+refs\/heads\/main:refs\/remotes\/origin\/main' '\+refs\/heads\/release\/1:refs\/remotes\/origin\/release\/1' '\+refs\/heads\/factorial/);
    assert.equal(repoSeedScript({ ...params, mode: 'checkout', baseBranch: 'main' }).match(/refs\/heads\/main:/g)?.length, 1);
  });

  it('sets origin/HEAD to the default branch the Lambda found', () => {
    assert.match(repoSeedScript({ ...params, defaultBranch: 'trunk' }), /^git symbolic-ref refs\/remotes\/origin\/HEAD 'refs\/remotes\/origin\/trunk'$/m);
  });

  it('checks out the existing branch instead of creating one, and prints the head before the default branch', () => {
    const script = repoSeedScript({ ...params, mode: 'checkout' });
    assert.match(script, /git checkout --quiet 'origin\/factorial\/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c'/);
    assert.match(script, /git branch --quiet 'factorial\/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c'/);
    assert.doesNotMatch(script, /checkout --quiet --no-track -b/);
    assert.ok(script.indexOf('git rev-parse HEAD') < script.lastIndexOf('symbolic-ref'));
  });

  it('creates a new branch at a fixed commit, and refuses an existing branch that is not there', () => {
    const at = 'a'.repeat(40);
    assert.match(repoSeedScript({ ...params, at }), new RegExp(`git checkout --quiet --no-track -b '${WORK}' '${at}'`));
    assert.match(
      repoSeedScript({ ...params, mode: 'checkout', at }),
      new RegExp(`test "\\$\\(git rev-parse HEAD\\)" = '${at}' \\|\\| \\{ echo 'branch ${WORK} is not at the expected commit ${at}' >&2; exit 1; \\}`),
    );
  });

  it("clears every file an earlier seed left, and writes none of the seed's", () => {
    const script = repoSeedScript(params);
    assert.match(script, /rm -rf \/workspace\/repo [^\n]*\/workspace\/rework\.md [^\n]*\/workspace\/plan\.md \/workspace\/plan\.json \/workspace\/diff\.patch \/workspace\/review\.json/);
    assert.doesNotMatch(script, /base64|> \/workspace\//);
  });

  it('rejects values that are not plain names, commits or URLs', () => {
    assert.throws(() => repoSeedScript({ ...params, owner: 'evil;rm -rf /' }), /not a valid GitHub name/);
    assert.throws(() => repoSeedScript({ ...params, name: "x'y" }), /not a valid GitHub name/);
    assert.throws(() => repoSeedScript({ ...params, branch: 'evil;rm', mode: 'checkout' }), /not a valid branch name/);
    assert.throws(() => repoSeedScript({ ...params, baseBranch: 'x;rm' }), /base branch/);
    assert.throws(() => repoSeedScript({ ...params, defaultBranch: '-x' }), /default branch/);
    assert.throws(() => repoSeedScript({ ...params, at: 'HEAD; rm -rf /' }), /start commit/);
    assert.throws(() => repoSeedScript({ ...params, bundleUrl: "https://x/'; rm -rf /" }), /bundle URL/);
    assert.throws(() => repoSeedScript({ ...params, bundleUrl: 'http://x/a' }), /bundle URL/);
  });
});

describe('sessionBranches and parseDefaultBranch', () => {
  it('lists the default, a different base and the work branch in checkout mode, each once', () => {
    assert.deepEqual(sessionBranches({ branch: WORK, mode: 'create' }, 'main'), ['main']);
    assert.deepEqual(sessionBranches({ branch: WORK, mode: 'create', baseBranch: 'release/1' }, 'main'), ['main', 'release/1']);
    assert.deepEqual(sessionBranches({ branch: WORK, mode: 'checkout', baseBranch: 'main' }, 'main'), ['main', WORK]);
  });

  it('reads the default branch from ls-remote --symref', () => {
    assert.equal(parseDefaultBranch(`ref: refs/heads/trunk\tHEAD\n${'a'.repeat(40)}\tHEAD\n`), 'trunk');
    assert.throws(() => parseDefaultBranch(`${'a'.repeat(40)}\tHEAD\n`), /no default branch/);
  });

  it("reads the session's head and default branch from its last two lines", () => {
    assert.deepEqual(parseSeedOutput(`noise\n${'b'.repeat(40)}\nmain\n`), { head: 'b'.repeat(40), defaultBranch: 'main' });
    assert.throws(() => parseSeedOutput('main\n'), /branch head/);
  });
});

const ON_MAIN = 'factorial/11111111-1111-4111-8111-111111111111'; // branched from main
const ON_RELEASE = 'factorial/22222222-2222-4222-8222-222222222222'; // branched from release/1

describe('seeding end to end, against a local repository', () => {
  let root = '';
  let bare = '';
  let workspace = '';
  let transferDir = '';
  const sha = { main1: '', main2: '', release: '', onRelease: '', onMain: '' };
  const target: SessionTarget = { arn: 'arn', qualifier: 'live', sessionId: 's' };
  const KEY = '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c/1/prepare/repo.bundle';

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();
  const session = (...args: string[]): string => git(join(workspace, 'repo'), ...args);

  /** Run a session script with bash, /workspace pointed at the temporary directory and no network protocol allowed. */
  const runLocally = (script: string): Promise<CommandResult> =>
    new Promise((resolve) => {
      execFile(
        'bash',
        ['-c', script.replaceAll('/workspace', workspace)],
        { encoding: 'utf8', env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } },
        (error, stdout, stderr) => resolve({ stdout, stderr, exitCode: error ? Number(error.code ?? 1) : 0 }),
      );
    });

  const runs: string[] = [];
  const deps: SeedRepositoryDeps = {
    token: async () => undefined,
    remoteUrl: () => bare,
    transfer: {
      upload: async (key, file) => {
        mkdirSync(dirname(join(transferDir, key)), { recursive: true });
        copyFileSync(file, join(transferDir, key));
      },
      presign: async (key) => `file://${join(transferDir, key)}`,
      remove: async (key) => rmSync(join(transferDir, key), { force: true }),
    },
    run: async (_target, script) => {
      runs.push(script);
      const result = await runLocally(script);
      if (result.exitCode !== 0) throw new Error(`Session command exited ${result.exitCode}: ${result.stderr}`);
      return result;
    },
  };
  const seed = (refs: Partial<RepoRefs>, override: Partial<SeedRepositoryDeps> = {}) =>
    seedRepository({ target, repository: { owner: 'o', name: 'n' }, transferKey: KEY, branch: ON_MAIN, mode: 'create', ...refs }, { ...deps, ...override });

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'repo-seed-'));
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

  beforeEach(() => {
    runs.length = 0;
    workspace = mkdtempSync(join(root, 'workspace-'));
    transferDir = mkdtempSync(join(root, 'transfer-'));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  const remoteRefs = (): string[] => session('for-each-ref', '--format=%(refname)', 'refs/remotes/origin').split('\n');

  it('a new item gets the default branch only, a new work branch on its tip, and origin/HEAD', async () => {
    assert.deepEqual(await seed({}), { head: sha.main2, defaultBranch: 'main' });
    assert.equal(session('symbolic-ref', 'refs/remotes/origin/HEAD'), 'refs/remotes/origin/main');
    assert.equal(session('symbolic-ref', '--short', 'HEAD'), ON_MAIN);
    assert.equal(session('rev-parse', 'HEAD'), sha.main2);
    assert.deepEqual(remoteRefs(), ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    assert.equal(session('remote', 'get-url', 'origin'), 'https://github.com/o/n.git');
    assert.equal(session('for-each-ref', '--format=%(upstream)', 'refs/heads'), '');
    assert.equal(session('log', '--format=%H', 'origin/HEAD..HEAD'), '');
    assert.equal(session('diff', 'origin/main...HEAD'), '');
    assert.equal(session('rev-list', '--count', 'HEAD'), '2'); // full history, not shallow
    assert.equal(existsSync(join(session('rev-parse', '--absolute-git-dir'), 'shallow')), false);
  });

  it('a new item pinned to a commit starts its branch there', async () => {
    assert.deepEqual(await seed({ at: sha.main1 }), { head: sha.main1, defaultBranch: 'main' });
    assert.equal(session('symbolic-ref', '--short', 'HEAD'), ON_MAIN);
    assert.equal(session('rev-list', '--count', 'origin/HEAD..HEAD'), '0');
  });

  it('an existing branch is checked out at the start commit, with the default branch and the merge base', async () => {
    assert.deepEqual(await seed({ mode: 'checkout', at: sha.onMain }), { head: sha.onMain, defaultBranch: 'main' });
    assert.equal(session('rev-parse', `refs/heads/${ON_MAIN}`), sha.onMain);
    assert.deepEqual(remoteRefs(), ['refs/remotes/origin/HEAD', `refs/remotes/origin/${ON_MAIN}`, 'refs/remotes/origin/main']);
    assert.equal(session('merge-base', 'origin/main', 'HEAD'), sha.main2);
    assert.match(session('diff', '--stat', 'origin/main...HEAD'), /m\.txt/);
    assert.equal(session('log', '--format=%H', 'origin/HEAD..HEAD'), sha.onMain);
  });

  it('an existing branch that is not at the start commit is refused before the session is touched', async () => {
    await assert.rejects(seed({ mode: 'checkout', at: sha.main1 }), /is not at the expected commit/);
    assert.equal(runs.length, 0);
    assert.deepEqual(readdirSync(transferDir), []);
  });

  it('the session refuses a bundle whose branch is not at the start commit', async () => {
    const result = await withGitWorkspace(async (ws) => {
      const file = join(ws.dir, 'repo.bundle');
      const bundled = await bundleRepository(ws, { branch: ON_MAIN, mode: 'checkout', remoteUrl: bare }, file);
      return runLocally(repoSeedScript({ owner: 'o', name: 'n', branch: ON_MAIN, mode: 'checkout', at: sha.main1, defaultBranch: bundled.defaultBranch, bundleUrl: `file://${file}` }));
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /is not at the expected commit/);
  });

  it('a rework on a non-default base has that base, the default branch, the work branch and the merge base', async () => {
    assert.deepEqual(await seed({ mode: 'checkout', branch: ON_RELEASE, baseBranch: 'release/1', at: sha.onRelease }), { head: sha.onRelease, defaultBranch: 'main' });
    assert.deepEqual(remoteRefs(), ['refs/remotes/origin/HEAD', `refs/remotes/origin/${ON_RELEASE}`, 'refs/remotes/origin/main', 'refs/remotes/origin/release/1']);
    assert.equal(session('symbolic-ref', 'refs/remotes/origin/HEAD'), 'refs/remotes/origin/main');
    assert.equal(session('merge-base', 'origin/release/1', 'HEAD'), sha.release);
    assert.match(session('diff', '--stat', 'origin/release/1...HEAD'), /r1\.txt[\s\S]*r2\.txt/);
    assert.equal(session('show', 'origin/release/1:release.txt'), 'release');
  });

  it('a rework whose base is the default branch has it once, as origin/HEAD and origin/main', async () => {
    await seed({ mode: 'checkout', baseBranch: 'main' });
    assert.deepEqual(remoteRefs(), ['refs/remotes/origin/HEAD', `refs/remotes/origin/${ON_MAIN}`, 'refs/remotes/origin/main']);
  });

  it('checking out a branch that is not on the remote fails in the Lambda', async () => {
    await assert.rejects(seed({ mode: 'checkout', branch: 'factorial/33333333-3333-4333-8333-333333333333' }), /on the remote/);
    assert.equal(runs.length, 0);
  });

  it('a start commit the bundle does not hold is refused', async () => {
    await assert.rejects(seed({ at: 'c'.repeat(40) }), /is not on main/);
  });

  it('leaves neither the URL nor the bundle in the workspace, the session or the bucket', async () => {
    await seed({ mode: 'checkout', branch: ON_RELEASE, baseBranch: 'release/1' });
    assert.equal(runs.length, 1);
    const bundleUrl = /curl [^\n]* '([^']+)'/.exec(runs[0] ?? '')?.[1] ?? '';
    assert.ok(bundleUrl.startsWith('file://'));
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
    const all = files(workspace);
    assert.ok(all.length > 0);
    for (const file of all) {
      if (!statSync(file).isFile()) continue;
      const content = readFileSync(file).toString('latin1');
      assert.ok(!content.includes(bundleUrl) && !content.includes('repo.bundle') && !content.includes('factorial-seed.'), file);
    }
    assert.doesNotMatch(session('config', '--list'), /bundle|extraheader/i);
    assert.deepEqual(readdirSync(join(transferDir, dirname(KEY))), []);
    assert.deepEqual(readdirSync('/tmp').filter((name) => name.startsWith('factorial-seed.')), []);
  });

  it("fails when the session's head is not the one the Lambda bundled, and still deletes the transfer object", async () => {
    const lying: SeedRepositoryDeps['run'] = async (t, script) => {
      const result = await deps.run(t, script, 600);
      return { ...result, stdout: `${'d'.repeat(40)}\nmain\n` };
    };
    await assert.rejects(seed({}, { run: lying }), /not [0-9a-f]{40} on main/);
    assert.deepEqual(readdirSync(join(transferDir, dirname(KEY))), []);
  });
});
