import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { KILL_AFTER_SECONDS, SETUP_FAILED } from '@factorial/verifiers/exit';

import { OutputForwarder, checkArgv, runCheck, seed, verifyTask, type CheckDeps } from './runner.ts';

const WORK_ITEM = '0b6e1f3a-0c1d-4e2f-9a3b-4c5d6e7f8a9b';
const SHA = '3bda0de2c4f1e5a6b7c8d9e0f1a2b3c4d5e6f7a8';
const verifier = { name: 'checks', kind: 'command', run: "npm ci && echo 'ok'", required: true, timeoutSeconds: 600 };
const taskEnv = (overrides: Record<string, string> = {}): Record<string, string> => ({
  WORK_ITEM_ID: WORK_ITEM,
  VERIFIER: JSON.stringify(verifier),
  VERIFY_SHA: SHA,
  VERIFY_BRANCH: 'factorial/issue-12',
  DEFAULT_BRANCH: 'main',
  REPOSITORY: 'octo/widgets',
  BUNDLE_URL: 'https://factorial-transfer.s3.eu-west-1.amazonaws.com/x/repo.bundle?X-Amz-Signature=abc',
  ...overrides,
});

const MIRROR_ENV = {
  AWS_REGION: 'eu-west-1',
  FACTORIAL_CODEARTIFACT_DOMAIN: 'factorial',
  FACTORIAL_CODEARTIFACT_DOMAIN_OWNER: '123456789012',
  FACTORIAL_CODEARTIFACT_REPOSITORY: 'factorial-npm',
};

describe('verifyTask', () => {
  it('reads the verifier, the commit, the branches and the bundle from the overrides', () => {
    const task = verifyTask(taskEnv());
    assert.deepEqual(task.check, { name: 'checks', run: "npm ci && echo 'ok'", timeoutSeconds: 600 });
    assert.equal(task.sha, SHA);
    assert.equal(task.branch, 'factorial/issue-12');
    assert.deepEqual(task.repository, { owner: 'octo', name: 'widgets' });
  });

  it('refuses input it should not act on', () => {
    assert.throws(() => verifyTask(taskEnv({ WORK_ITEM_ID: 'x' })), /UUID/);
    assert.throws(() => verifyTask(taskEnv({ VERIFY_SHA: 'abc' })), /commit sha/);
    assert.throws(() => verifyTask(taskEnv({ VERIFY_BRANCH: '--upload-pack=evil' })), /branch name/);
    assert.throws(() => verifyTask(taskEnv({ DEFAULT_BRANCH: 'a..b' })), /branch name/);
    assert.throws(() => verifyTask(taskEnv({ REPOSITORY: 'octo/widgets/x' })), /owner/);
    assert.throws(() => verifyTask(taskEnv({ BUNDLE_URL: 'file:///etc/shadow' })), /https/);
    assert.throws(() => verifyTask(taskEnv({ VERIFIER: JSON.stringify({ ...verifier, timeoutSeconds: 7201 }) })), /timeout/);
    assert.throws(() => verifyTask(taskEnv({ VERIFIER: JSON.stringify({ ...verifier, kind: 'sandbox' }) })), /kind/);
    assert.throws(() => verifyTask(taskEnv({ VERIFIER: JSON.stringify({ ...verifier, run: '  ' }) })), /command/);
  });
});

describe('seed', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();

  /** A repository with main and a work branch one commit ahead, as a bundle; returns the work head. */
  const fixture = (): { root: string; bundle: string; head: string; base: string } => {
    const root = mkdtempSync(path.join(tmpdir(), 'verifier-seed-'));
    const source = path.join(root, 'source');
    git(root, 'init', '--quiet', '--initial-branch=main', source);
    writeFileSync(path.join(source, 'a.txt'), 'a\n');
    git(source, 'add', 'a.txt');
    git(source, 'commit', '--quiet', '-m', 'base');
    const base = git(source, 'rev-parse', 'HEAD');
    git(source, 'checkout', '--quiet', '-b', 'factorial/issue-12');
    writeFileSync(path.join(source, 'b.txt'), 'b\n');
    git(source, 'add', 'b.txt');
    git(source, 'commit', '--quiet', '-m', 'change');
    const head = git(source, 'rev-parse', 'HEAD');
    const bundle = path.join(root, 'repo.bundle');
    git(source, 'bundle', 'create', '--quiet', bundle, 'refs/heads/main', 'refs/heads/factorial/issue-12');
    return { root, bundle, head, base };
  };

  it('puts the work branch at the tested commit, with origin/main for diffs, and removes the bundle', async () => {
    const { root, bundle, head, base } = fixture();
    try {
      const workspace = path.join(root, 'workspace');
      const tmp = mkdtempSync(path.join(root, 'tmp-'));
      await seed(
        { sha: head, branch: 'factorial/issue-12', defaultBranch: 'main', repository: { owner: 'octo', name: 'widgets' }, bundleUrl: `file://${bundle}` },
        { workspace, tmp, protocols: '=file', handOver: false },
      );
      const repo = path.join(workspace, 'repo');
      assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
      assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'factorial/issue-12');
      assert.equal(git(repo, 'merge-base', 'HEAD', 'origin/main'), base);
      assert.equal(git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'), 'origin/main');
      assert.equal(git(repo, 'remote', 'get-url', 'origin'), 'https://github.com/octo/widgets.git');
      assert.deepEqual(execFileSync('ls', ['-A', tmp]).toString(), '');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when the branch is not at the tested commit', async () => {
    const { root, bundle, base } = fixture();
    try {
      await assert.rejects(
        seed(
          { sha: base, branch: 'factorial/issue-12', defaultBranch: 'main', repository: { owner: 'octo', name: 'widgets' }, bundleUrl: `file://${bundle}` },
          { workspace: path.join(root, 'workspace'), tmp: root, protocols: '=file', handOver: false },
        ),
        /not the tested commit/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('downloads only over the protocol it is given', async () => {
    const { root, bundle, head } = fixture();
    try {
      await assert.rejects(
        seed(
          { sha: head, branch: 'factorial/issue-12', defaultBranch: 'main', repository: { owner: 'octo', name: 'widgets' }, bundleUrl: `file://${bundle}` },
          { workspace: path.join(root, 'workspace'), tmp: root, handOver: false },
        ),
        /curl failed/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('checkArgv', () => {
  it('runs the command with bash under timeout, which kills it after the grace period', () => {
    assert.deepEqual(checkArgv({ timeoutSeconds: 90, run: 'npm test' }), ['timeout', `--kill-after=${KILL_AFTER_SECONDS}`, '90', 'bash', '-c', 'npm test']);
  });
});

describe('OutputForwarder', () => {
  it('writes whole lines, redacted, joining a token split across writes', () => {
    const out: string[] = [];
    const forwarder = new OutputForwarder((text) => out.push(text));
    forwarder.add('first\n//registry/:_authToken=eyJ');
    forwarder.add('hbGciOiJIUzI1NiJ9abcdef\nlast');
    forwarder.end();
    assert.equal(out.join(''), 'first\n//registry/:_authToken=***\nlast\n');
    assert.doesNotMatch(out.join(''), /eyJhbGci/);
  });

  it('past the cap, keeps only the end and says how much is missing', () => {
    const out: string[] = [];
    const forwarder = new OutputForwarder((text) => out.push(text), 10, 6);
    for (const line of ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee']) forwarder.add(`${line}\n`);
    forwarder.end();
    assert.equal(out.join(''), 'aaaa\nbbbb\n[factorial: 5 bytes of output are not in the log; its last 10 bytes follow]\ndddd\neeee\n');
  });
});

describe('runCheck', () => {
  const recorder = () => {
    const calls: { prefix: readonly string[]; env: Readonly<Record<string, string>>; argv: readonly string[]; cwd: string }[] = [];
    const output: string[] = [];
    const deps = (overrides: Partial<CheckDeps> = {}): CheckDeps => ({
      env: {
        ...MIRROR_ENV,
        PATH: '/usr/bin',
        AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        AWS_SECRET_ACCESS_KEY: 'secret',
        AWS_SESSION_TOKEN: 'token',
        AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc',
        ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/abc',
        BUNDLE_URL: 'https://example/bundle?sig=1',
      },
      configureNpm: async () => 'https://registry.example/',
      run: async (runner, argv, options) => {
        calls.push({ prefix: runner.prefix, env: runner.env, argv, cwd: options.cwd });
        options.onData?.(Buffer.from('ok\n'));
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: '' };
      },
      write: (data) => output.push(data),
      prefix: ['drop', '--'],
      repository: '/tmp/repo',
      agentHome: '/tmp/home',
      ...overrides,
    });
    return { calls, output, deps };
  };

  it("runs the check as the agent with none of the task's credentials, the mirror in its environment, and passes its output on", async () => {
    const { calls, output, deps } = recorder();
    assert.equal(await runCheck({ timeoutSeconds: 60, run: 'npm test' }, deps()), 0);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.deepEqual(call!.prefix, ['drop', '--']);
    assert.equal(call!.cwd, '/tmp/repo');
    assert.deepEqual(call!.argv.slice(-3), ['bash', '-c', 'npm test']);
    for (const name of Object.keys(call!.env)) assert.doesNotMatch(name, /^(AWS_(ACCESS|SECRET|SESSION|CONTAINER)|ECS_|BUNDLE_URL)/, `${name} reached the check`);
    assert.equal(call!.env.HOME, '/tmp/home');
    assert.match(call!.env.NPM_CONFIG_REGISTRY ?? '', /^https:\/\/factorial-123456789012\.d\.codeartifact\.eu-west-1\.amazonaws\.com\/npm\/factorial-npm\/$/);
    assert.deepEqual(output, ['ok\n']);
  });

  it("returns the check's own exit status", async () => {
    const { deps } = recorder();
    assert.equal(await runCheck({ timeoutSeconds: 60, run: 'false' }, deps({ run: async () => ({ exitCode: 124, stdout: Buffer.alloc(0), stderr: '' }) })), 124);
  });

  it('starts nothing when the task names no mirror or the token cannot be minted', async () => {
    const noMirror = recorder();
    assert.equal(await runCheck({ timeoutSeconds: 60, run: 'npm test' }, noMirror.deps({ env: { AWS_REGION: 'eu-west-1', PATH: '/usr/bin' } })), SETUP_FAILED);
    assert.equal(noMirror.calls.length, 0);
    assert.match(noMirror.output.join(''), /names no npm mirror/);

    const noToken = recorder();
    const result = await runCheck(
      { timeoutSeconds: 60, run: 'npm test' },
      noToken.deps({
        configureNpm: async () => {
          throw new Error('AccessDenied');
        },
      }),
    );
    assert.equal(result, SETUP_FAILED);
    assert.equal(noToken.calls.length, 0);
  });
});
