import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ROLES, ROLE_NAMES, isRoleName, modelVariable, runtimeArnVariable } from './index.ts';

describe('role manifests', () => {
  it('name each role by its key, with a stage and statuses of its own', () => {
    const stages = new Set<string>();
    const statuses = new Set<string>();
    for (const name of ROLE_NAMES) {
      const role = ROLES[name];
      assert.equal(role.name, name);
      assert.ok(!stages.has(role.stage), role.stage);
      stages.add(role.stage);
      for (const status of Object.values(role.statuses)) {
        assert.ok(!statuses.has(status), status);
        statuses.add(status);
      }
    }
  });

  it('keep the records the builder and the reviewer always had', () => {
    assert.deepEqual(ROLES.builder.statuses, { running: 'building', done: 'built', failed: 'build-error' });
    assert.deepEqual(ROLES.reviewer.statuses, { running: 'reviewing', done: 'review-done', failed: 'review-error' });
    assert.equal(ROLES.builder.stage, 'build');
    assert.equal(ROLES.reviewer.stage, 'review');
  });

  it('derive the Runtime and model variables from the names', () => {
    assert.equal(runtimeArnVariable('builder'), 'BUILDER_RUNTIME_ARN');
    assert.equal(runtimeArnVariable('reviewer'), 'REVIEWER_RUNTIME_ARN');
    assert.equal(modelVariable('explore'), 'FACTORIAL_EXPLORE_MODEL');
  });

  it('know only the roles there are', () => {
    assert.ok(isRoleName('reviewer'));
    assert.ok(!isRoleName('planner'));
  });
});
