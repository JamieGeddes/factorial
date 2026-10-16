import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateWorkItem } from '@factorial/workitem';

import { BadPayloadError, decideIssueEvent } from './issue-event.ts';

const deliveryId = '2F9A6B3E-7C1D-4E5F-8A9B-0C1D2E3F4A5B';
const now = new Date('2026-10-16T22:00:00Z');

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'labeled',
    label: { name: 'factorial' },
    issue: {
      number: 7,
      title: 'Fix typo in README',
      body: 'The word "recieve" should be "receive".',
      html_url: 'https://github.com/JamieGeddes/factorial/issues/7',
      user: { login: 'someone-else' },
    },
    repository: { name: 'factorial', owner: { login: 'JamieGeddes' } },
    sender: { login: 'JamieGeddes' },
    ...overrides,
  };
}

describe('decideIssueEvent', () => {
  it('creates a valid WorkItem when the trigger label is added', () => {
    const decision = decideIssueEvent(payload(), { triggerLabel: 'factorial', deliveryId, now });
    assert.equal(decision.kind, 'work');
    if (decision.kind !== 'work') return;

    assert.equal(validateWorkItem(decision.workItem).ok, true);
    assert.deepEqual(decision.workItem, {
      schemaVersion: 1,
      id: deliveryId.toLowerCase(),
      source: {
        type: 'github-issue',
        id: '7',
        url: 'https://github.com/JamieGeddes/factorial/issues/7',
      },
      repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' },
      title: 'Fix typo in README',
      body: 'The word "recieve" should be "receive".',
      requestedBy: 'JamieGeddes',
      createdAt: '2026-10-16T22:00:00.000Z',
    });
  });

  it('attributes the work to whoever applied the label, not the issue author', () => {
    const decision = decideIssueEvent(payload({ sender: { login: 'approver' } }), {
      triggerLabel: 'factorial',
      deliveryId,
      now,
    });
    assert.equal(decision.kind === 'work' && decision.workItem.requestedBy, 'approver');
  });

  it('ignores the opened action even when the label is present', () => {
    const decision = decideIssueEvent(payload({ action: 'opened' }), { triggerLabel: 'factorial', deliveryId });
    assert.deepEqual(decision, { kind: 'ignore', reason: 'ignored action "opened"' });
  });

  it('ignores other labels', () => {
    const decision = decideIssueEvent(payload({ label: { name: 'bug' } }), { triggerLabel: 'factorial', deliveryId });
    assert.deepEqual(decision, { kind: 'ignore', reason: 'ignored label "bug"' });
  });

  it('respects a custom trigger label', () => {
    const decision = decideIssueEvent(payload({ label: { name: 'robot' } }), { triggerLabel: 'robot', deliveryId });
    assert.equal(decision.kind, 'work');
  });

  it('treats a null body as empty', () => {
    const decision = decideIssueEvent(payload({ issue: { ...(payload().issue as object), body: null } }), {
      triggerLabel: 'factorial',
      deliveryId,
    });
    assert.equal(decision.kind === 'work' && decision.workItem.body, '');
  });

  it('truncates an over-long title to the contract limit', () => {
    const decision = decideIssueEvent(
      payload({ issue: { ...(payload().issue as object), title: 'x'.repeat(300) } }),
      { triggerLabel: 'factorial', deliveryId },
    );
    assert.equal(decision.kind === 'work' && decision.workItem.title.length, 256);
  });

  it('generates an id when the delivery id is missing or not a UUID', () => {
    const missing = decideIssueEvent(payload(), { triggerLabel: 'factorial', deliveryId: undefined });
    const junk = decideIssueEvent(payload(), { triggerLabel: 'factorial', deliveryId: 'not-a-uuid' });
    assert.equal(missing.kind, 'work');
    assert.equal(junk.kind, 'work');
    assert.notEqual(missing.kind === 'work' && missing.workItem.id, junk.kind === 'work' && junk.workItem.id);
  });

  it('rejects a payload missing the issue', () => {
    assert.throws(
      () => decideIssueEvent({ action: 'labeled', repository: {}, sender: {} }, { triggerLabel: 'factorial', deliveryId }),
      BadPayloadError,
    );
  });

  it('rejects a non-object payload', () => {
    assert.throws(() => decideIssueEvent('nope', { triggerLabel: 'factorial', deliveryId }), BadPayloadError);
  });
});
