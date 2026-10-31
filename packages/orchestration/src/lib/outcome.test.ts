import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Outcome, OutcomeResult } from '@factorial/outcome';
import type { WorkItem } from '@factorial/workitem';

import { buildOutcome, emitOutcome, InvalidOutcomeError, recordResultInput, type OutcomeFacts, type OutcomeSinks } from './outcome.ts';

const workItem: WorkItem = {
  schemaVersion: 1,
  id: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  source: { type: 'github-pull-request-review', id: '77', url: 'https://github.com/JamieGeddes/factorial/pull/26#pullrequestreview-77' },
  inReplyTo: { kind: 'pull-request', number: 26 },
  repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' },
  title: 'Rework',
  body: 'Please rename.',
  requestedBy: 'alice',
  createdAt: '2026-10-31T09:00:00Z',
};

const facts = (overrides: Partial<OutcomeFacts> = {}): OutcomeFacts => ({
  workItem,
  attempt: 1,
  artefactPrefix: `${workItem.id}/1/`,
  result: 'pr-updated',
  route: 'change',
  threadKey: 'jamiegeddes/factorial#factorial/abc',
  pullRequest: { number: 26, url: 'https://github.com/JamieGeddes/factorial/pull/26' },
  branch: 'factorial/abc',
  testedSha: 'a'.repeat(40),
  at: '2026-10-31T12:00:00.000Z',
  ...overrides,
});

function sinks(failAt?: keyof OutcomeSinks): { sinks: OutcomeSinks; calls: string[] } {
  const calls: string[] = [];
  const step = (name: keyof OutcomeSinks) => async (...args: unknown[]) => {
    if (failAt === name) throw new Error(`${name} failed`);
    calls.push(`${name} ${JSON.stringify(args[1] ?? (args[0] as Outcome).result)}`);
  };
  return { sinks: { store: step('store'), record: step('record'), put: step('put') }, calls };
}

describe('buildOutcome', () => {
  it('copies the source, what the turn continues and the repository from the WorkItem, and no content', () => {
    const outcome = buildOutcome(facts());
    assert.deepEqual(outcome.source, workItem.source);
    assert.deepEqual(outcome.inReplyTo, { kind: 'pull-request', number: 26 });
    assert.equal(outcome.workItemId, workItem.id);
    assert.ok(!JSON.stringify(outcome).includes('Please rename'));
  });

  it('leaves out what is unknown', () => {
    const { inReplyTo: _i, ...issueItem } = { ...workItem, source: { type: 'github-issue', id: '7', url: 'https://github.com/JamieGeddes/factorial/issues/7' } };
    const outcome = buildOutcome({ workItem: issueItem, attempt: 1, artefactPrefix: `${workItem.id}/1/`, result: 'failed', threadKey: undefined, route: undefined, branch: undefined });
    assert.deepEqual(Object.keys(outcome).sort(), ['artefactPrefix', 'at', 'attempt', 'repository', 'result', 'schemaVersion', 'source', 'workItemId']);
  });

  it('drops a commit count of zero from saved work', () => {
    const outcome = buildOutcome(facts({ result: 'failed', testedSha: undefined, savedWork: { branch: 'factorial/abc', commits: 0 } }));
    assert.deepEqual(outcome.savedWork, { branch: 'factorial/abc' });
  });

  it('refuses an outcome that breaks the contract', () => {
    assert.throws(() => buildOutcome(facts({ testedSha: undefined })), InvalidOutcomeError);
    assert.throws(() => buildOutcome(facts({ result: 'refused' })), InvalidOutcomeError);
  });
});

describe('emitOutcome', () => {
  it('stores, records and then puts the outcome', async () => {
    const { sinks: s, calls } = sinks();
    const outcome = await emitOutcome(facts(), s);
    assert.deepEqual(calls.map((c) => c.split(' ')[0]), ['store', 'record', 'put']);
    assert.equal(calls[1], 'record "pr-updated"');
    assert.equal(outcome.result, 'pr-updated');
  });

  it('puts nothing when it could not record the outcome first', async () => {
    for (const failAt of ['store', 'record'] as const) {
      const { sinks: s, calls } = sinks(failAt);
      await assert.rejects(emitOutcome(facts(), s), new RegExp(`${failAt} failed`));
      assert.ok(!calls.some((c) => c.startsWith('put')), failAt);
    }
  });

  it('touches no sink for an invalid outcome', async () => {
    const { sinks: s, calls } = sinks();
    await assert.rejects(emitOutcome(facts({ result: 'refused' as OutcomeResult }), s), InvalidOutcomeError);
    assert.deepEqual(calls, []);
  });
});

describe('the ledger write', () => {
  it('sets the result on an existing row only', () => {
    const input = recordResultInput('factorial-work-items', workItem.id, 'no-changes');
    assert.equal(input.UpdateExpression, 'SET #result = :result');
    assert.equal(input.ConditionExpression, 'attribute_exists(workItemId)');
    assert.deepEqual(input.ExpressionAttributeValues, { ':result': 'no-changes' });
  });
});
