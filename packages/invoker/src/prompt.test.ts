import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPrompt } from './prompt.ts';

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

  it('points to the work item file and the notes file, since older messages are dropped', () => {
    const prompt = buildPrompt(workItem, 'b', 'main');
    assert.match(prompt, /re-read \/workspace\/workitem\.json/);
    assert.match(prompt, /\/workspace\/notes\.md/);
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

  it('does not quote review comments in the prompt itself; they live in rework.md', () => {
    const prompt = buildPrompt(reworkWorkItem, reworkWorkItem.context.branch, 'main');
    assert.doesNotMatch(prompt, /Add a test\./);
    assert.doesNotMatch(prompt, /@JamieGeddes/);
  });
});
