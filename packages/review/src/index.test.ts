import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { REVIEW_SCHEMA_VERSION, ReviewValidationError, assertReview, parseReviewJson, validateReview, type Review } from './index.ts';

const examplesDir = fileURLToPath(new URL('../../../contracts/review/v1/examples/', import.meta.url));

async function loadExample(name: string): Promise<Review> {
  return JSON.parse(await readFile(path.join(examplesDir, name), 'utf8')) as Review;
}

describe('Review schema', () => {
  it('accepts every example in the contract directory', async () => {
    const files = (await readdir(examplesDir)).filter((f) => f.endsWith('.json'));
    assert.ok(files.length > 0, 'expected at least one example');
    for (const file of files) {
      const result = validateReview(await loadExample(file));
      assert.ok(result.ok, `${file}: ${result.ok ? '' : result.errors.join('; ')}`);
    }
  });

  it('returns a typed value on success', async () => {
    const result = validateReview(await loadExample('request-changes.json'));
    assert.ok(result.ok);
    assert.equal(result.value.schemaVersion, REVIEW_SCHEMA_VERSION);
    assert.equal(result.value.verdict, 'request-changes');
    assert.equal(result.value.findings[0]?.severity, 'high');
  });

  it('accepts no findings and a finding without a line', async () => {
    const review = await loadExample('request-changes.json');
    assert.equal(validateReview({ ...review, findings: [] }).ok, true);
    assert.equal(review.findings[1]?.line, undefined);
  });

  it('rejects a missing required field and an unknown one', async () => {
    const missing = structuredClone(await loadExample('approve.json')) as Partial<Review>;
    delete missing.scores;
    const result = validateReview(missing);
    assert.ok(!result.ok && result.errors.some((e) => e.includes('scores')));

    const extra = { ...(await loadExample('approve.json')), rework: true };
    const extraResult = validateReview(extra);
    assert.ok(!extraResult.ok && extraResult.errors.some((e) => e.includes('"rework"')));
  });

  it('rejects unknown properties inside scores and a finding', async () => {
    const review = structuredClone(await loadExample('approve.json')) as unknown as {
      scores: Record<string, unknown>;
      findings: Array<Record<string, unknown>>;
    };
    review.scores.style = 3;
    review.findings[0]!.suggestion = 'rename';
    const result = validateReview(review);
    assert.ok(!result.ok && result.errors.length === 2);
  });

  it('rejects an unknown verdict or severity', async () => {
    const review = await loadExample('approve.json');
    assert.equal(validateReview({ ...review, verdict: 'reject' }).ok, false);
    assert.equal(validateReview({ ...review, findings: [{ ...review.findings[0]!, severity: 'critical' }] }).ok, false);
  });

  it('rejects scores outside 1 to 5 and fractional scores', async () => {
    const review = await loadExample('approve.json');
    for (const correctness of [0, 6, 3.5, '4']) {
      assert.equal(validateReview({ ...review, scores: { ...review.scores, correctness } }).ok, false, String(correctness));
    }
    for (const correctness of [1, 5]) {
      assert.equal(validateReview({ ...review, scores: { ...review.scores, correctness } }).ok, true, String(correctness));
    }
  });

  it('rejects a missing score', async () => {
    const review = await loadExample('approve.json');
    const { safety: _safety, ...scores } = review.scores;
    const result = validateReview({ ...review, scores });
    assert.ok(!result.ok && result.errors.some((e) => e.includes('safety')));
  });

  it('rejects absolute paths, paths that leave the repository and lines below 1', async () => {
    const review = await loadExample('approve.json');
    const finding = review.findings[0]!;
    for (const file of ['/etc/passwd', '../outside.ts', 'src/../../outside.ts', 'src/..']) {
      assert.equal(validateReview({ ...review, findings: [{ ...finding, path: file }] }).ok, false, file);
    }
    for (const file of ['src/a..b.ts', '.github/workflows/ci.yml']) {
      assert.equal(validateReview({ ...review, findings: [{ ...finding, path: file }] }).ok, true, file);
    }
    assert.equal(validateReview({ ...review, findings: [{ ...finding, line: 0 }] }).ok, false);
  });

  it('rejects more than 50 findings', async () => {
    const review = await loadExample('approve.json');
    const many = Array.from({ length: 51 }, () => review.findings[0]!);
    assert.equal(validateReview({ ...review, findings: many }).ok, false);
  });

  it('rejects a schemaVersion other than 1', async () => {
    assert.equal(validateReview({ ...(await loadExample('approve.json')), schemaVersion: 2 }).ok, false);
  });

  it('assertReview throws a ReviewValidationError listing every problem', () => {
    assert.throws(
      () => assertReview({ schemaVersion: 1 }),
      (error: unknown) => error instanceof ReviewValidationError && error.errors.length >= 4,
    );
  });

  it('parseReviewJson reports a syntax error as a validation error', () => {
    const result = parseReviewJson('{"schemaVersion": 1,');
    assert.ok(!result.ok && result.errors[0]?.startsWith('(root) is not valid JSON'));
  });

  it('parseReviewJson accepts valid text', async () => {
    const text = await readFile(path.join(examplesDir, 'approve.json'), 'utf8');
    assert.equal(parseReviewJson(text).ok, true);
  });
});
