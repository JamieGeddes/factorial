import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WorkContext } from '../lib/context.ts';

import { builderIncomplete } from '../lib/incomplete.ts';

import { commentTarget, invalidPlanProblems, reportArtefact, reportMessage, savedWorkNote } from './report.ts';

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
  threadKey: 'jamiegeddes/factorial#factorial/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
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
    const text = reportMessage({ status: 'failed', ctx, error: { Error: 'States.TaskFailed' }, saved: { pushed: true, commitCount: 1, itemCommitCount: 3 } });
    assert.match(text, /Work in progress \(3 commits\) was saved to/);
    assert.match(text, /https:\/\/github\.com\/JamieGeddes\/factorial\/tree\/factorial\/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c/);
    assert.match(text, /untested and no pull request was opened/);
  });

  it('uses the singular for one commit', () => {
    assert.match(savedWorkNote({ ctx, saved: { pushed: true, commitCount: 1, itemCommitCount: 1 } }), /\(1 commit\)/);
    assert.match(savedWorkNote({ ctx, saved: { pushed: true, commitCount: 1, itemCommitCount: 3 } }), /\(3 commits\)/);
  });

  it("counts the item's commits over every round, not the last round's", () => {
    // #78: round 3 committed 1 and the branch held 4.
    assert.match(savedWorkNote({ ctx, saved: { pushed: true, commitCount: 1, itemCommitCount: 4 } }), /\(4 commits\)/);
    assert.match(savedWorkNote({ ctx, saved: { pushed: true, commitCount: 0, itemCommitCount: 4 } }), /\(4 commits\)/);
  });

  it('leaves the count out when Collect gave no item count', () => {
    assert.match(savedWorkNote({ ctx, saved: { pushed: true, commitCount: 2 } }), /^ Work in progress was saved to /);
    assert.match(savedWorkNote({ ctx, saved: { pushed: true } }), /^ Work in progress was saved to /);
  });

  it('says nothing when nothing was pushed, or Collect did not run', () => {
    assert.equal(savedWorkNote({ ctx, saved: { pushed: false, commitCount: 0 } }), '');
    assert.equal(savedWorkNote({ ctx, saved: null }), '');
    assert.equal(savedWorkNote({ saved: { pushed: true, commitCount: 1, itemCommitCount: 2 } }), '');
  });
});

describe('a builder that stopped before finishing', () => {
  // The shape of an ecs:runTask.sync failure's cause, trimmed.
  const taskFailed = (exitCode: number) => ({
    Error: 'States.TaskFailed',
    Cause: JSON.stringify({ StopCode: 'EssentialContainerExited', Containers: [{ Name: 'invoker', ExitCode: exitCode, LastStatus: 'STOPPED' }] }),
  });

  it('is recognised by the invoker exit code', () => {
    assert.equal(builderIncomplete(taskFailed(3)), true);
    assert.equal(builderIncomplete(taskFailed(1)), false);
    assert.equal(builderIncomplete({ Error: 'Error', Cause: taskFailed(3).Cause }), false);
    assert.equal(builderIncomplete({ Error: 'States.TaskFailed', Cause: 'not json' }), false);
    assert.equal(builderIncomplete(undefined), false);
  });

  it('says the builder ran out, and links the saved work', () => {
    const text = reportMessage({ status: 'failed', ctx, error: taskFailed(3), saved: { pushed: true, commitCount: 1, itemCommitCount: 4 } });
    assert.match(text, /^Factorial's builder reached its iteration or time limit before finishing, so the change was not tested and no pull request was opened\./);
    assert.match(text, /Work in progress \(4 commits\) was saved to/);
    assert.doesNotMatch(text, /could not complete/);
  });

  it('says how many sessions the build had when it ran in rounds', () => {
    const text = reportMessage({ status: 'failed', ctx, error: taskFailed(3), buildRound: 6 });
    assert.match(text, /reached its iteration or time limit in 6 sessions before finishing/);
    assert.doesNotMatch(reportMessage({ status: 'failed', ctx, error: taskFailed(3), buildRound: 1 }), /sessions/);
  });

  it('keeps the generic message for other task failures', () => {
    assert.match(reportMessage({ status: 'failed', ctx, error: taskFailed(1) }), /^Factorial could not complete this work item/);
  });

  it('gives its own reason in report.json', () => {
    assert.equal(reportArtefact({ status: 'failed', error: taskFailed(3) }).reason, 'The builder reached its iteration or time limit before finishing.');
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
      errorMessage: 'The builder did not produce a valid plan:\n- /workspace/plan.json is missing\n- `x` ghs_abcdefghijklmnopqrstuvwxyz0123456789',
    });
    const message = reportMessage({ status: 'invalid-plan', error: { Error: 'InvalidPlan', Cause: cause } });
    assert.match(message, /did not produce a valid plan, so nothing was pushed/);
    assert.match(message, /- `\/workspace\/plan\.json is missing`/);
    assert.doesNotMatch(message, /ghs_abcdefghijklmnopqrstuvwxyz0123456789/);
    assert.match(message, /- ` x  ghs_\*\*\*`/);
  });

  it('shows what the builder wrote only as inline code, and drops JSON snippets', () => {
    const cause = JSON.stringify({
      errorType: 'InvalidPlan',
      errorMessage: [
        'The builder did not produce a valid plan:',
        '- plan.json (root) has unexpected property "@someone [x](https://evil.example)"',
        '- plan.json (root) is not valid JSON: Unexpected token, "@team see https://evil.example" is not valid JSON',
      ].join('\n'),
    });
    const problems = invalidPlanProblems(cause);
    assert.equal(problems[0], '`plan.json (root) has unexpected property "@someone [x](https://evil.example)"`');
    assert.equal(problems[1], '`plan.json (root) is not valid JSON`');
  });

  it('records the outcome in report.json', () => {
    assert.deepEqual(reportArtefact({ status: 'invalid-plan' }), {
      outcome: 'invalid-plan',
      reason: 'The builder did not produce a valid plan.',
    });
  });
});

describe('a rework item', () => {
  const reworkCtx: WorkContext = {
    ...ctx,
    workItem: {
      ...ctx.workItem,
      source: { type: 'github-pull-request-review', id: '77', url: 'https://github.com/JamieGeddes/factorial/pull/26#pullrequestreview-77' },
      inReplyTo: { kind: 'pull-request', number: 26 },
    },
    rework: {
      pullRequest: { number: 26, url: 'https://github.com/JamieGeddes/factorial/pull/26' },
      cause: 'review',
      previousWorkItemId: '1f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
      baseBranch: 'main',
    },
  };

  it('is reported on its pull request; anything else on its issue', () => {
    assert.equal(commentTarget(reworkCtx.workItem), 26);
    assert.equal(commentTarget(ctx.workItem), 7);
    assert.equal(commentTarget({ ...ctx.workItem, source: { type: 'jira', id: 'X-1', url: 'https://x' } }), undefined);
  });

  it('is reported on the pull request it replies to, before Prepare has run', () => {
    const reply = { ...ctx.workItem, source: { type: 'github-pull-request-comment', id: '9', url: 'https://github.com/JamieGeddes/factorial/pull/87#issuecomment-9' }, inReplyTo: { kind: 'pull-request' as const, number: 87 } };
    assert.equal(commentTarget(reply), 87);
    assert.match(reportMessage({ status: 'failed', workItem: reply, error: { Error: 'X' } }), /could not complete this work item/);
    assert.match(reportMessage({ status: 'no-changes', workItem: reply }), /the pull request was not updated/);
  });

  it('says the pull request was not updated, never that none was opened', () => {
    const text = reportMessage({ status: 'no-changes', ctx: reworkCtx, summary: 'Nothing to do.' });
    assert.match(text, /so the pull request was not updated\./);
    assert.doesNotMatch(text, /no pull request was opened/);
  });

  it('says failing commits are on the pull request when its tests fail', () => {
    const text = reportMessage({ status: 'tests-failed', ctx: reworkCtx, error: { Error: 'TestsFailed', Cause: JSON.stringify({ runUrl: 'https://x/run/9' }) } });
    assert.match(text, /rework did not pass the repository's checks \(\[run\]\(https:\/\/x\/run\/9\)\)/);
    assert.match(text, /pull request now includes them\. Do not merge/);
  });

  it('says saved work is on the pull request untested, without the relabel hint', () => {
    const note = savedWorkNote({ ctx: reworkCtx, saved: { pushed: true, commitCount: 1, itemCommitCount: 2 } });
    assert.match(note, /\(2 commits\) was saved to this pull request's branch, so the pull request now includes it untested/);
    assert.doesNotMatch(note, /label/);
  });

  it('says the builder ran out without claiming no pull request was opened', () => {
    const text = reportMessage({
      status: 'failed',
      ctx: reworkCtx,
      error: { Error: 'States.TaskFailed', Cause: JSON.stringify({ Containers: [{ Name: 'invoker', ExitCode: 3 }] }) },
      saved: { pushed: true, commitCount: 1, itemCommitCount: 1 },
    });
    assert.match(text, /iteration or time limit before finishing, so the change was not tested and the pull request was not updated\./);
    assert.match(text, /\(1 commit\) was saved to this pull request's branch/);
    assert.doesNotMatch(text, /no pull request was opened/);
  });
});
