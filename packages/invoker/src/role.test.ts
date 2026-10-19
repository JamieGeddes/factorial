import assert from 'node:assert/strict';
import { test } from 'node:test';

import { harnessTarget } from './role.ts';

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
  assert.throws(() => harnessTarget({ ...env, ROLE: 'planner' }), /Unknown agent role "planner"/);
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
