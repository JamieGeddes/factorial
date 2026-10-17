import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WorkContext } from '../lib/context.ts';

import { pullRequestBody } from './pr-body.ts';

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
  factorialVersion: '0123456789abcdef0123456789abcdef01234567',
};

describe('pullRequestBody', () => {
  it('leads with the summary and ends with the evidence table', () => {
    const body = pullRequestBody(ctx, '# Done\n\nFixed it.', { runUrl: 'https://x/run/1', outcome: 'success' }, 'f'.repeat(40));
    assert.ok(body.startsWith('# Done\n\nFixed it.'));
    assert.match(body, /\| Work item \| \[github-issue 7\]\(https:\/\/github\.com\/JamieGeddes\/factorial\/issues\/7\) \|/);
    assert.match(body, /\| Requested by \| @JamieGeddes \|/);
    assert.match(body, /\| Tests \| \[success\]\(https:\/\/x\/run\/1\) \|/);
    assert.match(body, /\| Head \| `ffffffffffff` \|/);
    assert.match(body, /\| Built by \| Factorial `0123456789ab` \|/);
  });

  it('says so when the agent wrote no summary and tests did not run', () => {
    const body = pullRequestBody(ctx, '   ', {}, 'a'.repeat(40));
    assert.match(body, /_The agent did not write a summary\._/);
    assert.match(body, /\| Tests \| not run \|/);
  });
});
