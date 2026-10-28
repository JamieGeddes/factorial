import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { MAX_REVIEW_BYTES, MAX_REVIEW_CHECKS, SECOND_PASS, reviewErrors, reviewStopCheck } from './review.ts';

const review = JSON.stringify({
  schemaVersion: 1,
  verdict: 'approve',
  scores: { correctness: 5, completeness: 5, tests: 4, safety: 5 },
  findings: [{ path: 'src/a.ts', line: 3, severity: 'low', body: 'Name the constant.' }],
  summary: 'Does what was asked.',
});

describe('reviewErrors', () => {
  it('accepts a valid review', () => {
    assert.equal(reviewErrors(review), undefined);
  });

  it('reports a missing, oversized or invalid review', () => {
    assert.deepEqual(reviewErrors(undefined), ['/workspace/review.json is missing']);
    assert.match(reviewErrors(' '.repeat(MAX_REVIEW_BYTES + 1))?.[0] ?? '', /over 65536 bytes/);
    assert.match((reviewErrors(JSON.stringify({ ...JSON.parse(review), verdict: 'lgtm' })) ?? []).join('\n'), /^review\.json /);
    assert.ok(reviewErrors('{ not json'));
  });
});

describe('reviewStopCheck', () => {
  it('sends the reviewer back while the review is missing, at most MAX_REVIEW_CHECKS times', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'review-'));
    const blocked: string[] = [];
    const check = reviewStopCheck(workspace, (reason) => blocked.push(reason));
    for (let i = 0; i < MAX_REVIEW_CHECKS; i += 1) assert.match(check() ?? '', /review\.json is missing/);
    assert.equal(check(), undefined);
    assert.equal(blocked.length, MAX_REVIEW_CHECKS);
  });

  it('sends the first valid review back once for a second pass, then lets it end', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'review-'));
    writeFileSync(path.join(workspace, 'review.json'), review);
    const blocked: string[] = [];
    const check = reviewStopCheck(workspace, (reason) => blocked.push(reason));
    assert.equal(check(), SECOND_PASS);
    assert.equal(check(), undefined);
    assert.deepEqual(blocked, [SECOND_PASS]);
  });

  it('asks for a valid review first, then for the second pass', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'review-'));
    const reasons: string[] = [];
    const check = reviewStopCheck(workspace, (reason) => reasons.push(reason));
    check();
    writeFileSync(path.join(workspace, 'review.json'), review);
    check();
    assert.equal(check(), undefined);
    assert.match(reasons[0] ?? '', /review\.json is missing/);
    assert.equal(reasons[1], SECOND_PASS);
    assert.equal(reasons.length, 2);
  });

  it('still checks a review the second pass made invalid', () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'review-'));
    writeFileSync(path.join(workspace, 'review.json'), review);
    const check = reviewStopCheck(workspace, () => {});
    check();
    writeFileSync(path.join(workspace, 'review.json'), '{ broken');
    assert.match(check() ?? '', /review contract/);
  });
});
