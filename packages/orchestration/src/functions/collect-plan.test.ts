import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InvalidPlanError, MAX_PLAN_ATTEMPTS, planOutcome } from './collect-plan.ts';
import { invalidPlanProblems } from './report.ts';

describe('planOutcome', () => {
  it('accepts a valid plan on either attempt', () => {
    assert.equal(planOutcome(true, 1), 'accept');
    assert.equal(planOutcome(true, 2), 'accept');
  });

  it('retries the first invalid plan once, then fails', () => {
    assert.equal(MAX_PLAN_ATTEMPTS, 2);
    assert.equal(planOutcome(false, 1), 'retry');
    assert.equal(planOutcome(false, 2), 'fail');
  });
});

describe('InvalidPlanError', () => {
  it('is named for the state machine catcher and lists the problems the report shows', () => {
    const error = new InvalidPlanError(['/workspace/plan.json is missing', 'plan.json /steps must NOT have fewer than 1 items']);
    assert.equal(error.name, 'InvalidPlan');
    const cause = JSON.stringify({ errorType: 'InvalidPlan', errorMessage: error.message });
    assert.deepEqual(invalidPlanProblems(cause), ['`/workspace/plan.json is missing`', '`plan.json /steps must NOT have fewer than 1 items`']);
  });
});
