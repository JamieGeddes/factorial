import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ROLE_STAGES, incompleteReason, outcomeAttributes, parseSensitivePaths, runtimeTarget } from './role.ts';

const env = {
  ROLE: 'builder',
  RUNTIME_ARN: 'arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/factorial_builder-NTDenOHhba',
  RUNTIME_QUALIFIER: 'live',
};

test('reads the role and its runtime from the task input', () => {
  assert.deepEqual(runtimeTarget(env), {
    role: 'builder',
    runtimeArn: env.RUNTIME_ARN,
    runtimeId: 'factorial_builder-NTDenOHhba',
    qualifier: 'live',
  });
});

test('requires every value', () => {
  for (const name of Object.keys(env)) {
    assert.throws(() => runtimeTarget({ ...env, [name]: undefined }), new RegExp(name));
  }
});

test('rejects a role it cannot start', () => {
  assert.throws(() => runtimeTarget({ ...env, ROLE: 'explorer' }), /Unknown agent role "explorer"/);
  assert.throws(() => runtimeTarget({ ...env, ROLE: 'planner' }), /Unknown agent role "planner"/);
});

test('reads the reviewer and its runtime', () => {
  const runtimeArn = 'arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/factorial_reviewer-Q7mXk2LpZa';
  const target = runtimeTarget({ ...env, ROLE: 'reviewer', RUNTIME_ARN: runtimeArn });
  assert.equal(target.role, 'reviewer');
  assert.equal(target.runtimeId, 'factorial_reviewer-Q7mXk2LpZa');
});

test("refuses a runtime that is not the role's", () => {
  assert.throws(() => runtimeTarget({ ...env, ROLE: 'reviewer' }), /does not name the reviewer runtime/);
  assert.throws(
    () => runtimeTarget({ ...env, RUNTIME_ARN: 'arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/other_builder-abc' }),
    /does not name the builder runtime/,
  );
  assert.throws(() => runtimeTarget({ ...env, RUNTIME_ARN: `${env.RUNTIME_ARN}/runtime-endpoint/live` }), /does not name/);
  assert.throws(() => runtimeTarget({ ...env, RUNTIME_ARN: 'arn:aws:bedrock-agentcore:eu-west-1:111122223333:harness/factorial_builder-abc' }), /does not name/);
});

test('rejects a malformed qualifier', () => {
  assert.throws(() => runtimeTarget({ ...env, RUNTIME_QUALIFIER: 'live endpoint' }), /not an endpoint name/);
});

test("the builder's outcome keeps its existing ledger names", () => {
  const outcome = { stopReason: 'success', toolCalls: 3, durationSeconds: 60, usage: { inputTokens: 1 }, error: undefined, record: { usageKey: 'k' } };
  assert.deepEqual(outcomeAttributes('builder', outcome), {
    stopReason: 'success',
    toolCalls: 3,
    buildDurationSeconds: 60,
    usage: { inputTokens: 1 },
    buildError: undefined,
    build: { usageKey: 'k' },
  });
});

test("another role's outcome sits under its stage and leaves the builder's fields alone", () => {
  const outcome = { stopReason: 'success', toolCalls: 2, durationSeconds: 30, usage: { inputTokens: 5 }, error: 'boom', record: { usageKey: 'p' } };
  assert.deepEqual(outcomeAttributes('reviewer', outcome), {
    review: { stopReason: 'success', toolCalls: 2, durationSeconds: 30, usage: { inputTokens: 5 }, error: 'boom', usageKey: 'p' },
  });
  assert.deepEqual(ROLE_STAGES.reviewer, { stage: 'review', running: 'reviewing', done: 'review-done', failed: 'review-error' });
});

test('reads the sensitive paths for the reviewer', () => {
  assert.deepEqual(parseSensitivePaths(undefined), []);
  assert.deepEqual(parseSensitivePaths('[]'), []);
  const paths = [
    { path: '.github/workflows/ci.yml', reason: 'changes GitHub Actions' },
    { path: 'infra/iam.yml', reason: 'changes IAM' },
  ];
  assert.deepEqual(parseSensitivePaths(JSON.stringify(paths)), paths);
});

test('refuses sensitive paths that are not repository paths', () => {
  const entry = (path: string, reason = 'changes IAM') => JSON.stringify([{ path, reason }]);
  for (const value of [
    '{}',
    '[1]',
    '["a.ts"]',
    entry('/etc/passwd'),
    entry('../x'),
    entry('a\nb'),
    entry('a`b'),
    entry('a.ts', ''),
    entry('a.ts', 'two\nlines'),
    entry('a.ts', 'x'.repeat(201)),
    JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ path: `f${i}`, reason: 'r' }))),
  ]) {
    assert.throws(() => parseSensitivePaths(value), /SENSITIVE_PATHS/, value);
  }
  assert.throws(() => parseSensitivePaths('not json'));
});

test('leaves the reviewer to its Collect step', () => {
  assert.equal(incompleteReason('reviewer', 'error_max_turns'), undefined);
});

test("treats the Agent SDK's success as a finished build and its limits as incomplete", () => {
  assert.equal(incompleteReason('builder', 'success'), undefined);
  assert.match(incompleteReason('builder', 'error_max_turns') ?? '', /stopped with error_max_turns/);
  assert.match(incompleteReason('builder', 'error_max_budget_usd') ?? '', /error_max_budget_usd/);
  assert.match(incompleteReason('builder', 'max_duration') ?? '', /max_duration/);
  assert.match(incompleteReason('builder', undefined) ?? '', /no stop reason/);
});
