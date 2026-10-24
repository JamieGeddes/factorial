import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ReworkContext, WorkItem } from '@factorial/workitem';

import { branchFor, issueNumber, reworkContext, workBranchFor } from './context.ts';

const rework = (branch: string): ReworkContext => ({
  kind: 'rework',
  pullRequest: { number: 5, url: 'https://github.com/JamieGeddes/factorial/pull/5' },
  branch,
  baseBranch: 'main',
  previousWorkItemId: 'prev',
  cause: 'review',
  details: [],
});

function item(overrides: { id?: string; sourceType?: string; sourceId?: string; context?: ReworkContext } = {}): WorkItem {
  return {
    id: overrides.id ?? 'abc-123',
    source: {
      type: overrides.sourceType ?? 'github-issue',
      id: overrides.sourceId ?? '22',
      url: 'https://github.com/JamieGeddes/factorial/issues/22',
    },
    repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' },
    ...(overrides.context ? { context: overrides.context } : {}),
  } as WorkItem;
}

describe('branchFor', () => {
  it('returns factorial/<id>', () => {
    assert.equal(branchFor(item({ id: 'abc-123' })), 'factorial/abc-123');
  });
});

describe('workBranchFor', () => {
  it('uses the fresh branch for a new item', () => {
    assert.equal(workBranchFor(item()), 'factorial/abc-123');
  });

  it('uses the previous branch for rework', () => {
    assert.equal(workBranchFor(item({ context: rework('factorial/prev') })), 'factorial/prev');
  });

  it('throws for a rework branch that is not a safe git branch', () => {
    assert.throws(() => workBranchFor(item({ context: rework('factorial/../evil') })));
  });
});

describe('reworkContext', () => {
  it('returns the context for rework', () => {
    const context = rework('factorial/prev');
    assert.equal(reworkContext(item({ context })), context);
  });

  it('returns undefined otherwise', () => {
    assert.equal(reworkContext(item()), undefined);
  });
});

describe('issueNumber', () => {
  it('returns the number for a github-issue source', () => {
    assert.equal(issueNumber(item({ sourceId: '22' })), 22);
  });

  it('returns undefined for another source type', () => {
    assert.equal(issueNumber(item({ sourceType: 'manual' })), undefined);
  });

  for (const bad of ['0', '-3', '1.5', 'abc']) {
    it(`returns undefined for id ${JSON.stringify(bad)}`, () => {
      assert.equal(issueNumber(item({ sourceId: bad })), undefined);
    });
  }
});
