import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateWorkItem, type WorkItem } from '@factorial/workitem';

import { buildReworkWorkItem } from './rework-item.ts';
import type { PullRequestRef } from './payloads.ts';

const deliveryId = '2f9a6b3e-7c1d-4e5f-8a9b-0c1d2e3f4a5b';
const now = new Date('2026-10-18T10:00:00Z');
const botLogin = 'my-factorial[bot]';
const repository = { name: 'factorial', owner: { login: 'JamieGeddes' } };
const pullRequest: PullRequestRef = {
  number: 7,
  html_url: 'https://github.com/JamieGeddes/factorial/pull/7',
  head: { ref: 'factorial/146b11c0', sha: 'a'.repeat(40) },
  base: { ref: 'main' },
  user: { login: 'my-factorial[bot]', type: 'Bot' },
};

const baseOptions = {
  repository,
  baseBranch: 'main',
  previousWorkItemId: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  botLogin,
  deliveryId,
  now,
};

describe('buildReworkWorkItem', () => {
  it('builds a valid review rework item with context, file and line in details', () => {
    const item = buildReworkWorkItem(
      { kind: 'rework-review', pullRequest, comment: { author: 'JamieGeddes', body: 'Fix this.', path: 'src/x.ts', line: 12 } },
      [],
      baseOptions,
    );
    assert.equal(validateWorkItem(item).ok, true);
    assert.deepEqual(item, {
      schemaVersion: 1,
      id: deliveryId,
      source: { type: 'github-pr-rework', id: '7', url: pullRequest.html_url },
      repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' },
      title: 'Rework PR #7: address review comments',
      body: 'Fix this.',
      requestedBy: 'JamieGeddes',
      createdAt: '2026-10-18T10:00:00.000Z',
      context: {
        kind: 'rework',
        pullRequest: { number: 7, url: pullRequest.html_url },
        branch: 'factorial/146b11c0',
        baseBranch: 'main',
        previousWorkItemId: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
        cause: 'review',
        details: [{ author: 'JamieGeddes', body: 'Fix this.', path: 'src/x.ts', line: 12 }],
      },
    } satisfies WorkItem);
  });

  it('falls back to a default body when the review comment is empty', () => {
    const item = buildReworkWorkItem(
      { kind: 'rework-review', pullRequest, comment: { author: 'JamieGeddes', body: '  ' } },
      [],
      baseOptions,
    );
    assert.equal(item.body, 'Address the review comments on PR #7.');
  });

  it('merges additional review comments from the API into details', () => {
    const item = buildReworkWorkItem(
      { kind: 'rework-review', pullRequest, comment: { author: 'JamieGeddes', body: 'See the other comments.' } },
      [{ author: 'reviewer', body: 'also this', path: 'src/y.ts' }],
      baseOptions,
    );
    assert.deepEqual(item.context?.details, [
      { author: 'reviewer', body: 'also this', path: 'src/y.ts' },
      { author: 'JamieGeddes', body: 'See the other comments.' },
    ]);
  });

  it('builds a checks-failed item whose details name the failing jobs, not their logs', () => {
    const item = buildReworkWorkItem(
      { kind: 'rework-checks-failed', pullRequest, headSha: 'a'.repeat(40) },
      [],
      {
        ...baseOptions,
        failingJobs: [
          { name: 'Typecheck, test and lint', url: 'https://github.com/JamieGeddes/factorial/actions/runs/1/job/1' },
          { name: 'Lint CloudFormation', url: 'https://github.com/JamieGeddes/factorial/actions/runs/1/job/2' },
        ],
      },
    );
    assert.equal(validateWorkItem(item).ok, true);
    assert.equal(item.context?.cause, 'checks-failed');
    assert.equal(item.requestedBy, botLogin);
    assert.deepEqual(item.context?.details, [
      {
        author: botLogin,
        body: 'The check "Typecheck, test and lint" failed.\nhttps://github.com/JamieGeddes/factorial/actions/runs/1/job/1',
      },
      {
        author: botLogin,
        body: 'The check "Lint CloudFormation" failed.\nhttps://github.com/JamieGeddes/factorial/actions/runs/1/job/2',
      },
    ]);
    assert.match(item.body, /Typecheck, test and lint, Lint CloudFormation/);
  });

  it('reuses the delivery id so redeliveries are idempotent, and caps details at 50', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ author: 'reviewer', body: `c${i}` }));
    const item = buildReworkWorkItem(
      { kind: 'rework-review', pullRequest, comment: { author: 'JamieGeddes', body: 'go' } },
      many,
      baseOptions,
    );
    assert.equal(item.id, deliveryId);
    assert.equal(item.context?.details.length, 50);
  });
});
