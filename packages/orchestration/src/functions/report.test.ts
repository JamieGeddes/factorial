import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WorkContext } from '../lib/context.ts';

import { reportArtefact, reportMessage, savedWorkNote } from './report.ts';

const ctx: WorkContext = {
  workItem: {
    schemaVersion: 1,
    id: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
    source: { type: 'github-issue', id: '7', url: 'https://github.com/JamieGeddes/factorial/issues/7' },
    repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' },
    title: 'Fix typo',
    body: '',
    requestedBy: 'JamieGeddes',
    createdAt: '2026-10-17T09:00:00Z',
  },
  sessionId: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  branch: 'factorial/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  baseBranch: 'main',
  baseCommit: 'b'.repeat(40),
  factorialVersion: '0123456789abcdef0123456789abcdef01234567',
  attempt: 1,
  artefactPrefix: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c/1/',
};

describe('reportMessage', () => {
  it('explains a no-change outcome and includes the agent summary', () => {
    const text = reportMessage({ status: 'no-changes', summary: 'Nothing to do.' });
    assert.match(text, /made no changes/);
    assert.match(text, /Nothing to do\./);
  });

  it('links the failed test run when the cause carries it', () => {
    const text = reportMessage({
      status: 'tests-failed',
      error: { Error: 'TestsFailed', Cause: JSON.stringify({ runUrl: 'https://x/run/9' }) },
    });
    assert.match(text, /\[run\]\(https:\/\/x\/run\/9\)/);
  });

  it('survives a non-JSON cause', () => {
    const text = reportMessage({ status: 'tests-failed', error: { Error: 'TestsFailed', Cause: 'boom' } });
    assert.match(text, /did not pass/);
  });

  it('never puts the failure cause in the public message', () => {
    const text = reportMessage({
      status: 'failed',
      error: { Error: 'States.TaskFailed', Cause: 'fatal: https://x-access-token:ghs_SECRET@github.com/o/r.git' },
      sessionIdHint: 'abc',
    });
    assert.match(text, /States\.TaskFailed/);
    assert.match(text, /Session `abc`/);
    assert.doesNotMatch(text, /SECRET|x-access-token|fatal/);
  });
});

describe('saved work after a failure', () => {
  it('links the branch and says the work is untested when Collect pushed it', () => {
    const text = reportMessage({ status: 'failed', ctx, error: { Error: 'States.TaskFailed' }, saved: { pushed: true, commitCount: 3 } });
    assert.match(text, /Work in progress \(3 commits\) was saved to/);
    assert.match(text, /https:\/\/github\.com\/JamieGeddes\/factorial\/tree\/factorial\/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c/);
    assert.match(text, /untested and no pull request was opened/);
  });

  it('uses the singular for one commit', () => {
    assert.match(savedWorkNote({ ctx, saved: { pushed: true, commitCount: 1 } }), /\(1 commit\)/);
  });

  it('says nothing when nothing was pushed, or Collect did not run', () => {
    assert.equal(savedWorkNote({ ctx, saved: { pushed: false, commitCount: 0 } }), '');
    assert.equal(savedWorkNote({ ctx, saved: null }), '');
    assert.equal(savedWorkNote({ saved: { pushed: true, commitCount: 2 } }), '');
  });
});

describe('reportArtefact', () => {
  it('records the outcome and a reason for each terminal status', () => {
    assert.deepEqual(reportArtefact({ status: 'no-changes' }), { outcome: 'no-changes', reason: 'The agent made no changes.' });
    assert.equal(reportArtefact({ status: 'tests-failed' }).outcome, 'tests-failed');
  });

  it('names the failing error and keeps the cause for the reviewer', () => {
    const record = reportArtefact({ status: 'failed', error: { Error: 'States.TaskFailed', Cause: 'clone failed' }, saved: { pushed: true } });
    assert.equal(record.reason, 'A step failed: States.TaskFailed.');
    assert.deepEqual(record.error, { Error: 'States.TaskFailed', Cause: 'clone failed' });
    assert.equal(record.savedWork, true);
  });
});

describe('invalid-plan report', () => {
  it('says nothing was built and lists the problems from the cause', () => {
    const cause = JSON.stringify({
      errorType: 'InvalidPlan',
      errorMessage: 'The planner did not produce a valid plan in 2 attempts:\n- /workspace/plan.json is missing\n- `x` ghs_abcdefghijklmnopqrstuvwxyz0123456789',
    });
    const message = reportMessage({ status: 'invalid-plan', error: { Error: 'InvalidPlan', Cause: cause } });
    assert.match(message, /did not produce a valid plan after two attempts, so nothing was built/);
    assert.match(message, /- \/workspace\/plan\.json is missing/);
    assert.doesNotMatch(message, /ghs_abcdefghijklmnopqrstuvwxyz0123456789/);
    assert.match(message, /- 'x' ghs_\*\*\*/);
  });

  it('records the outcome in report.json', () => {
    assert.deepEqual(reportArtefact({ status: 'invalid-plan' }), {
      outcome: 'invalid-plan',
      reason: 'The planner did not produce a valid plan after two attempts.',
    });
  });
});
