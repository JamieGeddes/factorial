import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ROLE_STAGES, harnessTarget, incompleteReason, outcomeAttributes, parseSensitivePaths } from './role.ts';

const env = {
  ROLE: 'builder',
  HARNESS_ID: 'factorial_builder-nic0aXWwQU',
  HARNESS_ARN: 'arn:aws:bedrock-agentcore:eu-west-1:111122223333:harness/factorial_builder-nic0aXWwQU',
  HARNESS_QUALIFIER: 'live',
};

test('reads the role and its harness from the task input', () => {
  assert.deepEqual(harnessTarget(env), {
    role: 'builder',
    harnessId: 'factorial_builder-nic0aXWwQU',
    harnessArn: env.HARNESS_ARN,
    qualifier: 'live',
  });
});

test('requires every value', () => {
  for (const name of Object.keys(env)) {
    assert.throws(() => harnessTarget({ ...env, [name]: undefined }), new RegExp(name === 'ROLE' ? 'ROLE' : name));
  }
});

test('rejects a role it cannot start', () => {
  assert.throws(() => harnessTarget({ ...env, ROLE: 'explorer' }), /Unknown agent role "explorer"/);
});

test("rejects another role's harness", () => {
  assert.throws(
    () => harnessTarget({ ...env, HARNESS_ID: 'factorial_reviewer-abc123' }),
    /not the builder harness/,
  );
});

test('rejects an ARN that names a different harness', () => {
  assert.throws(
    () => harnessTarget({ ...env, HARNESS_ARN: 'arn:aws:bedrock-agentcore:eu-west-1:111122223333:harness/factorial_builder-other1' }),
    /does not name harness/,
  );
});

test('rejects a malformed qualifier', () => {
  assert.throws(() => harnessTarget({ ...env, HARNESS_QUALIFIER: 'live endpoint' }), /not an endpoint name/);
});

test('reads the planner role and its harness', () => {
  const target = harnessTarget({
    ...env,
    ROLE: 'planner',
    HARNESS_ID: 'factorial_planner-AbC123',
    HARNESS_ARN: 'arn:aws:bedrock-agentcore:eu-west-1:111122223333:harness/factorial_planner-AbC123',
  });
  assert.equal(target.role, 'planner');
});

test("the builder's outcome keeps its existing ledger names", () => {
  const outcome = { stopReason: 'end_turn', toolCalls: 3, durationSeconds: 60, usage: { inputTokens: 1 }, error: undefined, record: { usageKey: 'k' } };
  assert.deepEqual(outcomeAttributes('builder', outcome), {
    stopReason: 'end_turn',
    toolCalls: 3,
    buildDurationSeconds: 60,
    usage: { inputTokens: 1 },
    buildError: undefined,
    build: { usageKey: 'k' },
  });
});

test("another role's outcome sits under its stage and leaves the builder's fields alone", () => {
  const outcome = { stopReason: 'end_turn', toolCalls: 2, durationSeconds: 30, usage: { inputTokens: 5 }, error: 'boom', record: { usageKey: 'p' } };
  assert.deepEqual(outcomeAttributes('planner', outcome), {
    plan: { stopReason: 'end_turn', toolCalls: 2, durationSeconds: 30, usage: { inputTokens: 5 }, error: 'boom', usageKey: 'p' },
  });
  assert.deepEqual(ROLE_STAGES.planner, { stage: 'plan', running: 'planning', done: 'planned', failed: 'plan-error' });
});

test('reads the reviewer role and its harness', () => {
  const target = harnessTarget({
    ...env,
    ROLE: 'reviewer',
    HARNESS_ID: 'factorial_reviewer-3i2nElr1PZ',
    HARNESS_ARN: 'arn:aws:bedrock-agentcore:eu-west-1:111122223333:harness/factorial_reviewer-3i2nElr1PZ',
  });
  assert.equal(target.role, 'reviewer');
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

test('treats a builder that stopped before end_turn as incomplete', () => {
  assert.equal(incompleteReason('builder', 'end_turn'), undefined);
  for (const reason of ['max_iterations_exceeded', 'timeout_exceeded', 'max_tokens']) {
    assert.match(incompleteReason('builder', reason) ?? '', new RegExp(`^incomplete: the builder stopped with ${reason}`));
  }
  assert.match(incompleteReason('builder', undefined) ?? '', /no stop reason/);
});

test('leaves the planner and the reviewer to their Collect steps', () => {
  assert.equal(incompleteReason('planner', 'max_iterations_exceeded'), undefined);
  assert.equal(incompleteReason('reviewer', 'timeout_exceeded'), undefined);
});
