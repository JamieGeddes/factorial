import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { builderSessionId, continuingSection } from './continue-files.ts';

const id = '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c';

describe('builderSessionId', () => {
  it('is the work item id for round 1 and a suffixed id after', () => {
    assert.equal(builderSessionId(id, 1), id);
    assert.equal(builderSessionId(id, 2), `${id}-r2`);
    assert.equal(builderSessionId(id, 10), `${id}-r10`);
  });

  it('stays a valid runtime session id (33 to 100 characters of [A-Za-z0-9_-])', () => {
    const session = builderSessionId(id, 6);
    assert.match(session, /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/);
    assert.ok(session.length >= 33 && session.length <= 100);
  });

  it('refuses a round that is not a positive integer', () => {
    for (const round of [0, -1, 1.5, Number.NaN]) assert.throws(() => builderSessionId(id, round), /round/);
  });
});

describe('continuingSection', () => {
  const base = 'b'.repeat(40);

  it('tells the new session the round, what is on the branch and how to pick up', () => {
    const text = continuingSection({ round: 2, baseCommit: base, pushed: true, commitCount: 3, planned: true });
    assert.match(text, /^\n# Continuing \(round 2\)\n/);
    assert.match(text, /Its 3 commits are on this branch\./);
    assert.match(text, /Save work in progress when the builder reached its limit/);
    assert.match(text, new RegExp(`git log --oneline ${base}\\.\\.HEAD`));
    assert.match(text, /Carry on from the first step not done\. Do not redo committed work\./);
  });

  it('uses the singular for one commit and says when nothing was committed', () => {
    assert.match(continuingSection({ round: 2, baseCommit: base, pushed: true, commitCount: 1, planned: true }), /Its commit is on this branch\./);
    const none = continuingSection({ round: 3, baseCommit: base, pushed: false, commitCount: 0, planned: true });
    assert.match(none, /It committed nothing, so the branch is as it was at the start\./);
    assert.doesNotMatch(none, /Save work in progress/);
  });

  it('checks the steps against an existing plan, or says to plan first when there is none', () => {
    const planned = continuingSection({ round: 2, baseCommit: base, pushed: true, commitCount: 2, planned: true });
    assert.match(planned, /Check each step in \/workspace\/plan\.json against the commits/);
    const unplanned = continuingSection({ round: 2, baseCommit: base, pushed: true, commitCount: 2, planned: false });
    assert.match(unplanned, /left no valid plan, so there is no \/workspace\/plan\.json\. Plan first/);
  });
});
