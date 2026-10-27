import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertIntakeRecord } from '../lib/intake-record.ts';
import { threadKeyFor, type Thread } from '../lib/thread.ts';

import { intakeRecord } from './intake.ts';

const ID = '3e9b1f4a-2c6d-4e8f-9a0b-1c2d3e4f5a6b';
const OPENER = '146b11c0-ca7d-11f1-9d6b-acd4bff0d455';
const BRANCH = `factorial/${OPENER}`;

const thread: Thread = {
  threadKey: threadKeyFor({ owner: 'JamieGeddes', name: 'factorial' }, BRANCH),
  owner: 'JamieGeddes',
  name: 'factorial',
  branch: BRANCH,
  openedBy: OPENER,
  sourceKey: 'github-issue#JamieGeddes/factorial#21',
  pullRequestKey: 'jamiegeddes/factorial#87',
  prNumber: 87,
  prOpenedBy: OPENER,
  version: 3,
  createdAt: '2026-10-27T09:00:00Z',
  updatedAt: '2026-10-27T09:00:00Z',
};

describe('threadKeyFor', () => {
  it('lower-cases the repository but keeps the branch as it is', () => {
    assert.equal(threadKeyFor({ owner: 'JamieGeddes', name: 'Factorial' }, 'factorial/AbC'), 'jamiegeddes/factorial#factorial/AbC');
  });
});

describe('intakeRecord', () => {
  it('records a rework turn with its pull request, cause and the opener from the thread', () => {
    const record = intakeRecord(ID, {
      route: 'change',
      turn: 'rework',
      reason: 'A request in the conversation on pull request #87, which Factorial opened.',
      thread,
      rework: { pullRequest: { number: 87, url: 'https://github.com/JamieGeddes/factorial/pull/87' }, cause: 'comment', previousWorkItemId: OPENER, baseBranch: 'main' },
    });
    assert.deepEqual(record, {
      schemaVersion: 1,
      workItemId: ID,
      route: 'change',
      turn: 'rework',
      reason: 'A request in the conversation on pull request #87, which Factorial opened.',
      threadKey: thread.threadKey,
      branch: BRANCH,
      pullRequest: 87,
      cause: 'comment',
      previousWorkItemId: OPENER,
    });
  });

  it('records a resumed request with the attempt it continues', () => {
    const record = intakeRecord(ID, { route: 'change', turn: 'resume', reason: 'Resumes.', thread, resumedFrom: { workItemId: OPENER, status: 'failed', savedWork: true, branch: BRANCH } });
    assert.equal(record.resumedFrom, OPENER);
    assert.equal(record.pullRequest, undefined);
  });

  it('records a refusal before the thread was found, and whether it was answered', () => {
    const record = intakeRecord(ID, { route: 'refuse', turn: 'rework', status: 'not-eligible', reason: 'Factorial has no record of opening pull request #3', prNumber: 3, cause: 'review' }, false);
    assert.equal(record.threadKey, undefined);
    assert.deepEqual(record.refusal, { status: 'not-eligible', replied: false });
    const busy = intakeRecord(ID, { route: 'refuse', turn: 'rework', status: 'busy', reason: 'running', prNumber: 87, cause: 'review', thread }, true);
    assert.equal(busy.previousWorkItemId, OPENER);
    assert.deepEqual(busy.refusal, { status: 'busy', replied: true });
  });

  it('cuts a long reason to the schema cap rather than fail', () => {
    const record = intakeRecord(ID, { route: 'refuse', turn: 'new', status: 'busy', reason: 'x'.repeat(2000), thread });
    assert.equal(record.reason.length, 1000);
  });
});

describe('the intake record schema', () => {
  const examplesDir = fileURLToPath(new URL('../../../../contracts/intake/v1/examples/', import.meta.url));

  it('accepts every example in the contract directory', async () => {
    const files = (await readdir(examplesDir)).filter((f) => f.endsWith('.json'));
    assert.ok(files.length > 0);
    for (const file of files) {
      const record: unknown = JSON.parse(await readFile(path.join(examplesDir, file), 'utf8'));
      assert.doesNotThrow(() => assertIntakeRecord(record), file);
    }
  });

  it('rejects an unknown route, an unknown field and a branch outside factorial/', () => {
    const base = { schemaVersion: 1, workItemId: ID, route: 'change', turn: 'new', reason: 'A new request.' };
    assert.doesNotThrow(() => assertIntakeRecord(base));
    assert.throws(() => assertIntakeRecord({ ...base, route: 'answer' }), /InvalidIntakeRecord|route/);
    assert.throws(() => assertIntakeRecord({ ...base, verdict: 'x' }));
    assert.throws(() => assertIntakeRecord({ ...base, branch: 'main' }));
    assert.throws(() => assertIntakeRecord({ ...base, refusal: { status: 'maybe', replied: false } }));
  });
});
