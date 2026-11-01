import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';

import { authConfigEnv, hardenedGitEnv, mustGit, redactToken, runGit, withGitWorkspace } from './git.ts';
import { gitAuthHeader } from './shell.ts';

const TOKEN = `ghs_${'t'.repeat(36)}`;

describe('hardenedGitEnv', () => {
  it('keeps out every configuration the system or a user could supply, and the Lambda credentials', () => {
    const saved = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    try {
      const env = hardenedGitEnv('/tmp/x/home');
      assert.equal(env.HOME, '/tmp/x/home');
      assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
      assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
      assert.equal(env.GIT_TERMINAL_PROMPT, '0');
      assert.equal(env.GIT_ASKPASS, '/bin/false');
      assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    } finally {
      if (saved === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = saved;
    }
  });
});

describe('authConfigEnv', () => {
  it('sends the token as http.extraHeader through the environment', () => {
    assert.deepEqual(authConfigEnv(TOKEN), { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: gitAuthHeader(TOKEN) });
    assert.throws(() => authConfigEnv('nope'), /unexpected format/);
  });
});

describe('redactToken', () => {
  it('removes the token, its basic credential and the header', () => {
    const header = gitAuthHeader(TOKEN);
    const basic = header.split(' ').pop() ?? '';
    const out = redactToken(`a ${TOKEN} b ${basic} c ${header}`, TOKEN);
    assert.ok(!out.includes(TOKEN) && !out.includes(basic) && !out.includes(header));
  });
});

describe('runGit', () => {
  it('runs in a temporary workspace with the hardened environment, and removes it afterwards', async () => {
    let dir = '';
    const header = await withGitWorkspace(async (workspace) => {
      dir = workspace.dir;
      assert.ok(existsSync(workspace.dir));
      await mustGit(workspace, ['init', '--quiet', 'r']);
      // The header reaches git as configuration, not as an argument.
      return (await mustGit(workspace, ['config', '--get', 'http.extraHeader'], { cwd: `${workspace.dir}/r`, token: TOKEN })).trim();
    });
    assert.equal(header, gitAuthHeader(TOKEN));
    assert.ok(!existsSync(dir));
  });

  it('reports a failure by subcommand, exit code and stderr, never its arguments', async () => {
    await withGitWorkspace(async (workspace) => {
      const result = await runGit(workspace, ['-c', 'core.hooksPath=/dev/null', 'rev-parse', '--verify', '--quiet', 'refs/heads/none']);
      assert.notEqual(result.exitCode, 0);
      await assert.rejects(mustGit(workspace, ['-c', 'x.secret=hidden', 'log', '-1'], { token: TOKEN }), (error: Error) => {
        assert.match(error.message, /^git log exited \d+: /);
        assert.ok(!error.message.includes('hidden'));
        assert.ok(!error.message.includes(TOKEN));
        return true;
      });
    });
  });

  it('removes the workspace when the work throws', async () => {
    let dir = '';
    await assert.rejects(
      withGitWorkspace(async (workspace) => {
        dir = workspace.dir;
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.ok(!existsSync(dir));
  });
});
