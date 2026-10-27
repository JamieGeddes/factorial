import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WorkItem } from '@factorial/workitem';

import { branchFor, issueNumber } from './context.ts';

function item(overrides: { id?: string; sourceType?: string; sourceId?: string } = {}): WorkItem {
  return {
    id: overrides.id ?? 'abc-123',
    source: {
      type: overrides.sourceType ?? 'github-issue',
      id: overrides.sourceId ?? '22',
      url: 'https://github.com/JamieGeddes/factorial/issues/22',
    },
    repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' },
  } as WorkItem;
}

describe('branchFor', () => {
  it('returns factorial/<id>', () => {
    assert.equal(branchFor(item({ id: 'abc-123' })), 'factorial/abc-123');
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
