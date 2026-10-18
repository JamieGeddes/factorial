import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WorkItem } from '@factorial/workitem';

import { resumableAttempt, sourceKey, type Attempt } from './resume.ts';

const current = 'cccccccc-0000-4000-8000-000000000000';
const saved: Attempt = { workItemId: 'a1', status: 'failed', savedWork: true, branch: 'factorial/a1' };

describe('sourceKey', () => {
  it('combines the source type, repository and source id', () => {
    const workItem = {
      source: { type: 'github-issue', id: '22', url: 'https://github.com/JamieGeddes/factorial/issues/22' },
      repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' },
    } as WorkItem;
    assert.equal(sourceKey(workItem), 'github-issue#JamieGeddes/factorial#22');
  });
});

describe('resumableAttempt', () => {
  it('resumes a failure that saved work', () => {
    assert.equal(resumableAttempt([saved], current), saved);
  });

  it('resumes a run whose tests failed', () => {
    const tested: Attempt = { workItemId: 'a2', status: 'tests-failed', savedWork: false, branch: 'factorial/a2' };
    assert.equal(resumableAttempt([tested], current), tested);
  });

  it('skips the current item and failures that saved nothing', () => {
    const attempts: Attempt[] = [
      { workItemId: current, status: 'prepared', branch: 'factorial/c' },
      { workItemId: 'a3', status: 'failed', savedWork: false, branch: 'factorial/a1' },
      saved,
    ];
    assert.equal(resumableAttempt(attempts, current), saved);
  });

  it('starts fresh after a pull request, no changes, or a run in progress', () => {
    for (const status of ['pr-opened', 'no-changes', 'prepared']) {
      assert.equal(resumableAttempt([{ workItemId: 'a4', status, branch: 'factorial/a4' }, saved], current), undefined, status);
    }
  });

  it('starts fresh when there is no earlier attempt or no branch was recorded', () => {
    assert.equal(resumableAttempt([], current), undefined);
    assert.equal(resumableAttempt([{ workItemId: 'a5', status: 'failed', savedWork: true }], current), undefined);
  });
});
