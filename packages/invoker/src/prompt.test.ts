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

  it('marks an empty body explicitly', () => {
    assert.match(buildPrompt({ ...workItem, body: '  ' }, 'b', 'main'), /_No further description was given\._/);
  });
});
