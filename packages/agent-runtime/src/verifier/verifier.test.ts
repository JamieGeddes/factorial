import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import { pingTracker } from '../server.ts';

import { KILL_AFTER_SECONDS, SETUP_FAILED, checkArgv, parseArguments, runCheck, type CheckDeps } from './command.ts';
import { createVerifierServer, verifierPing } from './host.ts';

const MIRROR_ENV = {
  AWS_REGION: 'eu-west-1',
  FACTORIAL_CODEARTIFACT_DOMAIN: 'factorial',
  FACTORIAL_CODEARTIFACT_DOMAIN_OWNER: '123456789012',
  FACTORIAL_CODEARTIFACT_REPOSITORY: 'factorial-npm',
};

const encode = (run: string): string => Buffer.from(run, 'utf8').toString('base64');

describe('parseArguments', () => {
  it('reads the timeout and the command, base64 so no quoting reaches the line', () => {
    assert.deepEqual(parseArguments(['600', encode("npm ci && echo 'done'")]), { timeoutSeconds: 600, run: "npm ci && echo 'done'" });
  });

  it('refuses a bad timeout, a command that is not base64, and an empty one', () => {
    assert.throws(() => parseArguments(['0', encode('true')]));
    assert.throws(() => parseArguments(['3601', encode('true')]));
    assert.throws(() => parseArguments(['60', 'not base64!']));
    assert.throws(() => parseArguments(['60', encode('   ')]));
  });
});

describe('checkArgv', () => {
  it('runs the command with bash under timeout, which kills it after the grace period', () => {
    assert.deepEqual(checkArgv({ timeoutSeconds: 90, run: 'npm test' }), ['timeout', `--kill-after=${KILL_AFTER_SECONDS}`, '90', 'bash', '-c', 'npm test']);
  });
});

describe('runCheck', () => {
  const recorder = () => {
    const calls: { prefix: readonly string[]; env: Readonly<Record<string, string>>; argv: readonly string[]; cwd: string }[] = [];
    const busy: string[] = [];
    const output: string[] = [];
    const deps = (overrides: Partial<CheckDeps> = {}): CheckDeps => ({
      env: { ...MIRROR_ENV, PATH: '/usr/bin', AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'token', AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials' },
      configureNpm: async () => 'https://registry.example/',
      run: async (runner, argv, options) => {
        calls.push({ prefix: runner.prefix, env: runner.env, argv, cwd: options.cwd });
        options.onData?.(Buffer.from('ok\n'));
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: '' };
      },
      write: (data) => output.push(String(data)),
      busy: { set: () => busy.push('set'), clear: () => busy.push('clear') },
      prefix: ['drop', '--'],
      repository: '/tmp/repo',
      agentHome: '/tmp/home',
      ...overrides,
    });
    return { calls, busy, output, deps };
  };

  it('runs the check as the agent with no AWS credentials, the mirror in its environment, and passes its output on', async () => {
    const { calls, busy, output, deps } = recorder();
    assert.equal(await runCheck({ timeoutSeconds: 60, run: 'npm test' }, deps()), 0);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.deepEqual(call!.prefix, ['drop', '--']);
    assert.equal(call!.cwd, '/tmp/repo');
    assert.deepEqual(call!.argv.slice(-3), ['bash', '-c', 'npm test']);
    for (const name of Object.keys(call!.env)) assert.doesNotMatch(name, /^AWS_(ACCESS|SECRET|SESSION|CONTAINER)/, `${name} reached the check`);
    assert.equal(call!.env.HOME, '/tmp/home');
    assert.match(call!.env.NPM_CONFIG_REGISTRY ?? '', /^https:\/\/factorial-123456789012\.d\.codeartifact\.eu-west-1\.amazonaws\.com\/npm\/factorial-npm\/$/);
    assert.deepEqual(busy, ['set', 'clear']);
    assert.deepEqual(output, ['ok\n']);
  });

  it("returns the check's own exit status", async () => {
    const { deps } = recorder();
    assert.equal(await runCheck({ timeoutSeconds: 60, run: 'false' }, deps({ run: async () => ({ exitCode: 124, stdout: Buffer.alloc(0), stderr: '' }) })), 124);
  });

  it('starts nothing when the Runtime version names no mirror or the token cannot be minted', async () => {
    const noMirror = recorder();
    assert.equal(await runCheck({ timeoutSeconds: 60, run: 'npm test' }, noMirror.deps({ env: { AWS_REGION: 'eu-west-1', PATH: '/usr/bin' } })), SETUP_FAILED);
    assert.equal(noMirror.calls.length, 0);
    assert.match(noMirror.output.join(''), /names no npm mirror/);

    const noToken = recorder();
    const result = await runCheck({ timeoutSeconds: 60, run: 'npm test' }, noToken.deps({ configureNpm: async () => { throw new Error('AccessDenied'); } }));
    assert.equal(result, SETUP_FAILED);
    assert.equal(noToken.calls.length, 0);
    assert.deepEqual(noToken.busy, []);
  });

  it('clears the busy marker when the run throws', async () => {
    const { busy, deps } = recorder();
    await assert.rejects(runCheck({ timeoutSeconds: 60, run: 'x' }, deps({ run: async () => { throw new Error('spawn failed'); } })));
    assert.deepEqual(busy, ['set', 'clear']);
  });
});

describe('verifier host', () => {
  it('reports HealthyBusy while the marker is there, and Healthy after', () => {
    let busy = true;
    let clock = 100;
    const ping = verifierPing(() => busy, pingTracker(() => clock));
    assert.equal(ping().status, 'HealthyBusy');
    clock = 200;
    busy = false;
    assert.deepEqual(ping(), { status: 'Healthy', time_of_last_update: 200 });
  });

  it('answers /ping and refuses every invocation', async () => {
    const server = createVerifierServer(() => ({ status: 'Healthy', time_of_last_update: 1 }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const ping = await fetch(`http://127.0.0.1:${port}/ping`);
      assert.equal(ping.status, 200);
      assert.deepEqual(await ping.json(), { status: 'Healthy', time_of_last_update: 1 });
      const invoke = await fetch(`http://127.0.0.1:${port}/invocations`, { method: 'POST', body: JSON.stringify({ action: 'run', prompt: 'x' }) });
      assert.equal(invoke.status, 403);
    } finally {
      server.close();
    }
  });
});
