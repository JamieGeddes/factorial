import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ROLE_STAGES, harnessTarget, outcomeAttributes } from './role.ts';

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
  assert.throws(() => harnessTarget({ ...env, ROLE: 'reviewer' }), /Unknown agent role "reviewer"/);
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
