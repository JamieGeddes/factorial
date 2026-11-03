import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateVerifierResult, type Verifier, type VerifierResult } from '@factorial/verifiers';

import type { WorkContext } from '../lib/context.ts';
import type { Logger } from '../lib/log.ts';
import { VerifierFailedError } from '../lib/verify.ts';
import { collectVerifier, judge, logStreamOf, stoppedTask, tailOf, type CollectVerifierDeps, type CollectVerifierInput, type StoppedTask } from './collect-verifier.ts';
import { prepareVerifyStage, verifierBundle, verifierBundleKey } from './prepare-verify.ts';

const ID = '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c';
const HEAD = 'c'.repeat(40);
const TASK_ARN = 'arn:aws:ecs:eu-west-1:123456789012:task/factorial-build/0123456789abcdef0123456789abcdef';
const checks: Verifier = { name: 'checks', kind: 'command', run: 'npm test', required: true, timeoutSeconds: 600 };
const ctx = {
  workItem: { id: ID, repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' } },
  branch: 'factorial/x',
  artefactPrefix: `${ID}/1/`,
} as unknown as WorkContext;

const task = (exitCode: number | undefined, overrides: Partial<StoppedTask> = {}): StoppedTask => ({
  TaskArn: TASK_ARN,
  StartedAt: Date.parse('2026-11-02T10:00:00.000Z'),
  StoppedAt: Date.parse('2026-11-02T10:04:12.000Z'),
  StoppedReason: 'Essential container in task exited',
  Containers: [{ Name: 'verifier', ...(exitCode === undefined ? {} : { ExitCode: exitCode }) }],
  ...overrides,
});

const input = (overrides: Partial<CollectVerifierInput> = {}): CollectVerifierInput => ({
  ctx,
  collect: { headSha: HEAD },
  verifier: checks,
  index: 0,
  startedAt: '2026-11-02T09:59:00.000Z',
  ...overrides,
});

/** A failed RunVerifier state: Step Functions puts the stopped task in the cause. */
const taskFailed = (stopped: StoppedTask) => ({ Error: 'States.TaskFailed', Cause: JSON.stringify(stopped) });

const now = new Date('2026-11-02T10:10:00.000Z');

describe('stoppedTask', () => {
  it("reads the task from the state's result, or from a TaskFailed cause, and from nothing else", () => {
    assert.equal(stoppedTask({ task: task(0) })?.TaskArn, TASK_ARN);
    assert.equal(stoppedTask({ error: taskFailed(task(1)) })?.Containers?.[0]?.ExitCode, 1);
    assert.equal(stoppedTask({ error: { Error: 'States.Timeout', Cause: JSON.stringify(task(1)) } }), undefined);
    assert.equal(stoppedTask({ error: { Error: 'States.TaskFailed', Cause: 'not json' } }), undefined);
  });
});

describe('judge', () => {
  it("reads the verifier container's exit status, with the task's own times", () => {
    const passed = judge(input({ task: task(0) }), HEAD, now);
    assert.equal(passed.outcome, 'passed');
    assert.equal(passed.exitCode, 0);
    assert.equal(passed.startedAt, '2026-11-02T10:00:00.000Z');
    assert.equal(passed.durationSeconds, 252);
    assert.equal(judge(input({ error: taskFailed(task(1)) }), HEAD, now).outcome, 'failed');
    assert.equal(judge(input({ error: taskFailed(task(124)) }), HEAD, now).outcome, 'timed-out');
    assert.equal(judge(input({ error: taskFailed(task(125)) }), HEAD, now).outcome, 'error');
  });

  it('reads the times as date strings too', () => {
    const result = judge(input({ task: task(0, { StartedAt: '2026-11-02T10:00:00Z', StoppedAt: '2026-11-02T10:01:00Z' }) }), HEAD, now);
    assert.equal(result.durationSeconds, 60);
  });

  it('calls a container killed for memory an error, not a failure of the change', () => {
    const stopped = task(137, { Containers: [{ Name: 'verifier', ExitCode: 137, Reason: 'OutOfMemoryError: Container killed due to memory usage' }] });
    const result = judge(input({ error: taskFailed(stopped) }), HEAD, now);
    assert.equal(result.outcome, 'error');
    assert.match(result.detail ?? '', /out of memory/);
  });

  it('never passes a verifier without an exit status: a state timeout is timed-out, anything else an error', () => {
    const timedOut = judge(input({ error: { Error: 'States.Timeout' } }), HEAD, now);
    assert.equal(timedOut.outcome, 'timed-out');
    assert.equal(timedOut.durationSeconds, 660);
    const unpulled = judge(input({ error: taskFailed(task(undefined, { StoppedReason: 'CannotPullContainerError: pull access denied' })) }), HEAD, now);
    assert.equal(unpulled.outcome, 'error');
    assert.match(unpulled.detail ?? '', /CannotPullContainerError/);
    const prepare = judge(input({ error: { Error: 'Error', Cause: 'branch moved' } }), HEAD, now);
    assert.equal(prepare.outcome, 'error');
    assert.match(prepare.detail ?? '', /the step failed \(Error\)/);
    // A task in another container's name is not this verifier's.
    assert.equal(judge(input({ task: task(0, { Containers: [{ Name: 'other', ExitCode: 0 }] }) }), HEAD, now).outcome, 'error');
    for (const result of [timedOut, unpulled, prepare]) assert.ok(validateVerifierResult(result).ok);
  });
});

describe('the log', () => {
  it("names the task's stream from its ARN", () => {
    assert.equal(logStreamOf(TASK_ARN), 'verifier/verifier/0123456789abcdef0123456789abcdef');
    assert.equal(logStreamOf('arn:aws:ecs:eu-west-1:123456789012:task/0123'), undefined);
  });

  it('keeps the end, cut to whole characters, and says when earlier output is left out', () => {
    assert.deepEqual(tailOf(['one', 'two'], false), { text: 'one\ntwo\n', truncated: false });
    assert.deepEqual(tailOf(['one', 'two'], true), { text: 'one\ntwo\n', truncated: true });
    assert.deepEqual(tailOf(['aaaa', 'é', 'bb'], false, 5), { text: '\nbb\n', truncated: true });
  });
});

describe('collectVerifier', () => {
  const quiet: Logger = { info: () => {}, error: () => {}, with: () => quiet };
  const recorder = (log: { text: string; truncated: boolean } | undefined = { text: 'ok\n', truncated: false }) => {
    const written: Record<string, unknown> = {};
    const removed: string[] = [];
    const deps: CollectVerifierDeps = {
      readLog: async () => log,
      putText: async (_prefix, path, text) => void (written[path] = text),
      putJson: async (_prefix, path, value) => void (written[path] = value),
      removeBundle: async (key) => void removed.push(key),
      now: () => now,
    };
    return { written, removed, deps };
  };

  it('writes the log and the result, deletes the bundle and returns the digest for a pass', async () => {
    const { written, removed, deps } = recorder();
    const digest = await collectVerifier(input({ task: task(0) }), quiet, deps);
    assert.equal(digest.outcome, 'passed');
    assert.equal(written['verify/checks/output.log'], 'ok\n');
    const result = written['verify/checks/result.json'] as VerifierResult;
    assert.deepEqual(result.log, { key: `${ID}/1/verify/checks/output.log`, bytes: 3, truncated: false });
    assert.deepEqual(removed, [`${ID}/1/verify/checks/repo.bundle`]);
  });

  it('stops the turn for a required verifier that failed, and not for an optional one', async () => {
    const required = recorder();
    await assert.rejects(collectVerifier(input({ error: taskFailed(task(1)) }), quiet, required.deps), VerifierFailedError);
    assert.equal((required.written['verify/checks/result.json'] as VerifierResult).outcome, 'failed');
    const optional = recorder();
    const digest = await collectVerifier(input({ verifier: { ...checks, required: false }, error: taskFailed(task(1)) }), quiet, optional.deps);
    assert.equal(digest.outcome, 'failed');
  });

  it('records a verifier whose task never ran, with no log', async () => {
    const { written, deps } = recorder(undefined);
    await assert.rejects(collectVerifier(input({ error: { Error: 'States.Timeout' } }), quiet, deps), VerifierFailedError);
    const result = written['verify/checks/result.json'] as VerifierResult;
    assert.equal(result.outcome, 'timed-out');
    assert.equal(result.log, undefined);
    assert.equal(written['verify/checks/output.log'], undefined);
  });

  it('judges the verifier even when its log cannot be read', async () => {
    const { written, deps } = recorder();
    const digest = await collectVerifier(input({ task: task(0) }), quiet, { ...deps, readLog: async () => Promise.reject(new Error('throttled')) });
    assert.equal(digest.outcome, 'passed');
    assert.equal((written['verify/checks/result.json'] as VerifierResult).log, undefined);
  });
});

describe('PrepareVerify', () => {
  it("bundles the work branch at the tested commit, under the verifier's own transfer key", () => {
    const params = verifierBundle({ ctx, collect: { headSha: HEAD }, verifier: checks, index: 1 });
    assert.equal(params.branch, 'factorial/x');
    assert.equal(params.at, HEAD);
    assert.deepEqual(params.repository, { owner: 'JamieGeddes', name: 'factorial' });
    assert.equal(params.transferKey, verifierBundleKey(ctx, checks));
    assert.equal(params.transferKey, `${ID}/1/verify/checks/repo.bundle`);
    assert.equal(params.baseBranch, undefined);
  });

  it('refuses a head that is not a commit sha', () => {
    assert.throws(() => verifierBundle({ ctx, collect: { headSha: 'main' }, verifier: checks, index: 0 }), /not a commit sha/);
  });

  it('leaves the Verify stage open whether it succeeds or fails: CollectVerifier and the states after it end it', () => {
    assert.deepEqual(prepareVerifyStage, { endsLater: true, failureEndsLater: true });
  });
});
