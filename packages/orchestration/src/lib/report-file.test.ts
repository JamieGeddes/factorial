import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseReportFile } from './report-file.ts';

const parse = (value: unknown) => parseReportFile(typeof value === 'string' ? value : JSON.stringify(value));
const errorOf = (value: unknown): string | undefined => {
  const result = parse(value);
  return result.ok ? undefined : result.error;
};

const runDetails = { source: { type: 't', id: '1', url: 'https://x' }, requestedBy: 'a', branch: 'b', factorialVersion: 'v', sessionId: 's', artefactPrefix: 'p' };
const reply = { cause: 'review', requestedBy: 'a', headSha: 'h', test: {}, points: [{ author: 'a' }], summaryText: '', runDetails };

describe('parseReportFile', () => {
  it('accepts each delivery kind, and a report from before deliveries', () => {
    for (const delivery of [
      { kind: 'pr-opened' },
      { kind: 'refusal' },
      { kind: 'refusal', reply: 'No.' },
      { kind: 'report', facts: { status: 'failed', rework: false, errorName: 'X', savedWork: { branch: 'b', commits: 2 } } },
      { kind: 'rework-reply', reply, reviewers: ['a'] },
    ]) {
      assert.equal(errorOf({ outcome: 'x', reason: 'y', delivery }), undefined, JSON.stringify(delivery));
    }
    assert.equal(errorOf({ outcome: 'pr-opened', reason: 'y' }), undefined);
  });

  it('refuses what is not a report', () => {
    assert.equal(errorOf('not json'), 'report.json is not valid JSON');
    assert.equal(errorOf([]), 'report.json is not an object');
    assert.equal(errorOf({ reason: 'y' }), 'report.json has no outcome or reason');
  });

  it('refuses a delivery whose facts are malformed', () => {
    const report = (delivery: unknown) => ({ outcome: 'x', reason: 'y', delivery });
    assert.equal(errorOf(report({ kind: 'unknown' })), 'delivery.kind is unknown');
    assert.equal(errorOf(report({ kind: 'report', facts: { status: 'pr-opened', rework: false } })), 'facts.status is not a report status');
    assert.equal(errorOf(report({ kind: 'report', facts: { status: 'failed', rework: false, planProblems: [1] } })), 'facts.planProblems is not a list of strings');
    assert.equal(errorOf(report({ kind: 'rework-reply', reply: { ...reply, cause: 'other' }, reviewers: [] })), 'reply.cause is not a rework cause');
    assert.equal(errorOf(report({ kind: 'rework-reply', reply: { ...reply, points: [{}] }, reviewers: [] })), 'reply.points is malformed');
    assert.equal(errorOf(report({ kind: 'rework-reply', reply, reviewers: 'a' })), 'reviewers is not a list of logins');
    assert.equal(errorOf(report({ kind: 'refusal', reply: 1 })), 'reply is not a string');
  });
});
