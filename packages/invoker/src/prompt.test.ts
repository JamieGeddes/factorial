import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPrompt, planPrompt } from './prompt.ts';

const workItem = {
  schemaVersion: 1 as const,
  id: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  source: { type: 'github-issue', id: '7', url: 'https://github.com/JamieGeddes/factorial/issues/7' },
  repository: { provider: 'github' as const, owner: 'JamieGeddes', name: 'factorial' },
  title: 'Fix typo',
  body: 'The word "recieve" should be "receive".',
  requestedBy: 'JamieGeddes',
  createdAt: '2026-10-17T09:00:00Z',
};

describe('buildPrompt', () => {
  it('includes the request, where the code is and what to produce', () => {
    const prompt = buildPrompt(workItem, 'factorial/7f3c', 'main');
    assert.match(prompt, /## Fix typo/);
    assert.match(prompt, /"recieve" should be "receive"/);
    assert.match(prompt, /Branch: factorial\/7f3c \(based on main\)/);
    assert.match(prompt, /\/workspace\/repo/);
    assert.match(prompt, /\/workspace\/summary\.md/);
  });

  it('asks for commits as the work progresses, not only at the end', () => {
    assert.match(buildPrompt(workItem, 'b', 'main'), /Commit on this branch as you go/);
  });

  it('points to the work item file and the notes file, since older messages are condensed', () => {
    const prompt = buildPrompt(workItem, 'b', 'main');
    assert.match(prompt, /\/workspace\/notes\.md already starts with this request/);
  });

  it("points at the planner's plan before any code, and asks for a report on each step", () => {
    const prompt = buildPrompt(workItem, 'b', 'main');
    assert.match(prompt, /its plan is \/workspace\/plan\.md .* Read it before changing any code and follow it step by step/);
    assert.match(prompt, /Re-read the Task section before each commit and before writing the summary/);
    assert.match(prompt, /a "## Plan steps" section: one line per plan step id, saying done, skipped or changed/);
  });

  it('marks an empty body explicitly', () => {
    assert.match(buildPrompt({ ...workItem, body: '  ' }, 'b', 'main'), /_No further description was given\._/);
  });

  it('adds no rework instructions to an ordinary item', () => {
    const prompt = buildPrompt(workItem, 'b', 'main');
    assert.doesNotMatch(prompt, /rework\.md/);
    assert.doesNotMatch(prompt, /rework of an existing pull request/i);
  });
});

const reworkWorkItem = {
  ...workItem,
  id: '9c8b7a6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d',
  title: 'Rework PR #26',
  body: 'Address the review.',
  context: {
    kind: 'rework' as const,
    pullRequest: { number: 26, url: 'https://github.com/JamieGeddes/factorial/pull/26' },
    branch: 'factorial/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
    baseBranch: 'main',
    previousWorkItemId: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
    cause: 'review' as const,
    details: [{ author: 'JamieGeddes', body: 'Add a test.' }],
  },
};

describe('buildPrompt for rework', () => {
  it('tells the agent to read rework.md, build on the branch and report per point', () => {
    const prompt = buildPrompt(reworkWorkItem, reworkWorkItem.context.branch, 'main');
    assert.match(prompt, /Read \/workspace\/rework\.md/);
    assert.match(prompt, /building on the existing work on the branch rather than starting over/);
    assert.match(prompt, /how each of the points in \/workspace\/rework\.md was handled/);
  });

  it('tells the agent to re-read rework.md once older messages are condensed', () => {
    const prompt = buildPrompt(reworkWorkItem, reworkWorkItem.context.branch, 'main');
    assert.match(prompt, /re-read it and \/workspace\/rework\.md rather than relying on memory/);
  });

  it('does not quote review comments in the prompt itself; they live in rework.md', () => {
    const prompt = buildPrompt(reworkWorkItem, reworkWorkItem.context.branch, 'main');
    assert.doesNotMatch(prompt, /Add a test\./);
    assert.doesNotMatch(prompt, /@JamieGeddes/);
  });
});

describe('planPrompt', () => {
  it('gives the request and asks for both plan files without changing the repository', () => {
    const prompt = planPrompt(workItem, 'factorial/x', 'main', 1);
    assert.match(prompt, /## Fix typo\n\nThe word "recieve" should be "receive"\./);
    assert.match(prompt, /Read it; do not change it\./);
    assert.match(prompt, /Write \/workspace\/plan\.md and \/workspace\/plan\.json/);
    assert.doesNotMatch(prompt, /rejected/);
  });

  it('on a retry, points at the rejection in the notes', () => {
    assert.match(planPrompt(workItem, 'b', 'main', 2), /under "# Plan rejected \(attempt 1\)" in \/workspace\/notes\.md/);
  });

  it('mentions rework.md for rework items', () => {
    const rework = {
      ...workItem,
      context: {
        kind: 'rework' as const,
        pullRequest: { number: 7, url: 'https://github.com/JamieGeddes/factorial/pull/7' },
        branch: 'factorial/x',
        baseBranch: 'main',
        previousWorkItemId: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
        cause: 'review' as const,
        details: [],
      },
    };
    assert.match(planPrompt(rework, 'b', 'main', 1), /\/workspace\/rework\.md lists every point the plan must address/);
  });
});
