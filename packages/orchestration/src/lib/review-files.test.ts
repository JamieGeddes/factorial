import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Review } from '@factorial/review';

import {
  MAX_REVIEW_FILE_BYTES,
  checkReviewFile,
  parseReviewRead,
  parseReviewSeed,
  readReviewScript,
  reviewDigest,
  seedReviewScript,
  sensitiveChanges,
  withGuardFindings,
} from './review-files.ts';

const SECTION = '\n===FACTORIAL-REVIEW===\n';
const nulList = (paths: string[]): string => Buffer.from(paths.map((p) => `${p}\0`).join(''), 'utf8').toString('base64');

const review: Review = {
  schemaVersion: 1,
  verdict: 'comment',
  scores: { correctness: 4, completeness: 4, tests: 3, safety: 5 },
  findings: [
    { path: 'src/a.ts', line: 3, severity: 'medium', body: 'Handle the empty case.' },
    { path: 'src/a.test.ts', severity: 'low', body: 'Add a failing case.' },
  ],
  summary: 'Works, with two gaps.',
};

describe('seedReviewScript', () => {
  it('writes the files and diffs three-dot against the base branch', () => {
    const script = seedReviewScript({ baseBranch: 'main', planJson: '{}', planMarkdown: '# Plan', summary: 'Done' });
    assert.match(script, /> \/workspace\/plan\.json/);
    assert.match(script, /> \/workspace\/plan\.md/);
    assert.match(script, /> \/workspace\/summary\.md/);
    assert.match(script, /git diff --no-color --no-ext-diff 'origin\/main\.\.\.HEAD' > \/workspace\/diff\.patch/);
    assert.match(script, /-G '\[Pp\]ermissions-\?\[Bb\]oundary'/);
    assert.equal(script.match(/--name-only --no-renames/g)?.length, 2);
    assert.match(script, /GIT_CONFIG_GLOBAL=\/dev\/null/);
  });

  it('refuses a base branch that is not a branch name', () => {
    assert.throws(() => seedReviewScript({ baseBranch: 'main; rm -rf /', planJson: '{}', planMarkdown: '', summary: '' }));
  });

  it('never puts file content into the script unencoded', () => {
    const script = seedReviewScript({ baseBranch: 'main', planJson: "'; touch /x; '", planMarkdown: '$(id)', summary: '`id`' });
    assert.doesNotMatch(script, /touch \/x|\$\(id\)|`id`/);
  });
});

describe('parseReviewSeed', () => {
  it('reads both NUL-separated path lists', () => {
    const seed = parseReviewSeed(`${nulList(['a.ts', 'dir/with space.ts', 'new\nline.ts'])}${SECTION}${nulList(['templates/20-agent.yml'])}\n`);
    assert.deepEqual(seed, { changedPaths: ['a.ts', 'dir/with space.ts', 'new\nline.ts'], boundaryPaths: ['templates/20-agent.yml'] });
  });

  it('reads empty lists', () => {
    assert.deepEqual(parseReviewSeed(`${SECTION}`), { changedPaths: [], boundaryPaths: [] });
  });

  it('refuses output that is not two base64 sections', () => {
    assert.throws(() => parseReviewSeed('abc'), /expected 2 path lists/);
    assert.throws(() => parseReviewSeed(`not base64!${SECTION}`), /base64/);
  });
});

describe('sensitiveChanges', () => {
  it('flags workflows, the foundation template and boundary changes, and nothing else', () => {
    const changes = sensitiveChanges({
      changedPaths: ['src/a.ts', '.github/workflows/ci.yml', '.github/actions/classify-changes/action.yml', 'templates/00-foundation.yml', 'templates/20-agent.yml', '.github/CODEOWNERS'],
      boundaryPaths: ['templates/20-agent.yml'],
    });
    assert.deepEqual(changes.map((c) => c.path), ['.github/workflows/ci.yml', '.github/actions/classify-changes/action.yml', 'templates/00-foundation.yml', 'templates/20-agent.yml']);
    assert.match(changes[0]!.reason, /GitHub Actions/);
    assert.match(changes[1]!.reason, /GitHub Actions/);
    assert.match(changes[2]!.reason, /foundation/);
    assert.match(changes[3]!.reason, /permissions boundary/);
  });

  it('ignores a boundary path that is not among the changed paths', () => {
    assert.deepEqual(sensitiveChanges({ changedPaths: ['src/a.ts'], boundaryPaths: ['templates/x.yml'] }), []);
  });

  it('keeps at most 20', () => {
    const changedPaths = Array.from({ length: 30 }, (_, i) => `.github/workflows/w${i}.yml`);
    assert.equal(sensitiveChanges({ changedPaths, boundaryPaths: [] }).length, 20);
  });
});

describe('reading review.json', () => {
  it('reads only a regular file, capped', () => {
    const script = readReviewScript();
    assert.match(script, /\[ -f '\/workspace\/review\.json' \] && \[ ! -L '\/workspace\/review\.json' \]/);
    assert.match(script, new RegExp(`head -c ${MAX_REVIEW_FILE_BYTES + 1}`));
  });

  it('parses a present and a missing file', () => {
    const text = JSON.stringify(review);
    assert.deepEqual(parseReviewRead(`ok:${text.length}:${Buffer.from(text).toString('base64')}`), { text, size: text.length });
    assert.equal(parseReviewRead('missing:'), undefined);
    assert.throws(() => parseReviewRead('garbage'), /base64/);
  });

  it('takes the larger of the reported and received sizes, and treats oversized base64 as over the cap', () => {
    const text = JSON.stringify(review);
    assert.equal(parseReviewRead(`ok:1:${Buffer.from(text).toString('base64')}`)?.size, text.length);
    const huge = 'A'.repeat(Math.ceil((MAX_REVIEW_FILE_BYTES + 1) / 3) * 4 + 4);
    assert.equal(parseReviewRead(`ok:1:${huge}`)?.size, Number.MAX_SAFE_INTEGER);
  });
});

describe('checkReviewFile', () => {
  it('accepts a valid review', () => {
    const text = JSON.stringify(review);
    const checked = checkReviewFile({ text, size: text.length });
    assert.ok(checked.ok);
    assert.equal(checked.review.verdict, 'comment');
  });

  it('reports a missing, oversized, unparseable or invalid review', () => {
    assert.deepEqual(checkReviewFile(undefined), { ok: false, errors: ['/workspace/review.json is missing'] });
    const big = checkReviewFile({ text: '{}', size: MAX_REVIEW_FILE_BYTES + 1 });
    assert.ok(!big.ok && /over the/.test(big.errors[0]!));
    const bad = checkReviewFile({ text: '{', size: 1 });
    assert.ok(!bad.ok && /not valid JSON/.test(bad.errors[0]!));
    const invalid = checkReviewFile({ text: JSON.stringify({ ...review, verdict: 'merge' }), size: 10 });
    assert.ok(!invalid.ok && invalid.errors.every((e) => e.startsWith('review.json ')));
  });

  it('redacts before validating, so what is stored is what was checked', () => {
    const text = JSON.stringify({ ...review, summary: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked' });
    const checked = checkReviewFile({ text, size: text.length });
    assert.ok(checked.ok);
    assert.doesNotMatch(checked.json, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
    assert.doesNotMatch(checked.review.summary, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  });
});

describe('withGuardFindings', () => {
  const changes = [
    { path: '.github/workflows/ci.yml', reason: 'changes a GitHub Actions workflow' },
    { path: 'templates/00-foundation.yml', reason: 'changes the foundation stack' },
  ];

  it('adds a high-severity finding for each sensitive change, first, and leaves the verdict alone', () => {
    const { review: guarded, added } = withGuardFindings(review, changes);
    assert.equal(added, 2);
    assert.equal(guarded.verdict, 'comment');
    assert.deepEqual(guarded.findings.slice(0, 2).map((f) => [f.path, f.severity]), [
      ['.github/workflows/ci.yml', 'high'],
      ['templates/00-foundation.yml', 'high'],
    ]);
    assert.match(guarded.findings[0]!.body, /^Added by the orchestrator: this changes a GitHub Actions workflow\./);
    assert.equal(guarded.findings.length, 4);
  });

  it('adds its finding even when the reviewer wrote its own for the same path', () => {
    const flagged = { ...review, findings: [{ path: '.github/workflows/ci.yml', severity: 'high' as const, body: 'Reviewed: nothing to worry about.' }] };
    const { review: guarded, added } = withGuardFindings(flagged, changes);
    assert.equal(added, 2);
    assert.deepEqual(guarded.findings.map((f) => f.path), ['.github/workflows/ci.yml', 'templates/00-foundation.yml', '.github/workflows/ci.yml']);
    assert.match(guarded.findings[0]!.body, /^Added by the orchestrator/);
  });

  it('keeps within the contract limit of 50 findings', () => {
    const many = { ...review, findings: Array.from({ length: 50 }, (_, i) => ({ path: `f${i}.ts`, severity: 'low' as const, body: 'x' })) };
    const { review: guarded } = withGuardFindings(many, changes);
    assert.equal(guarded.findings.length, 50);
    assert.equal(guarded.findings[0]!.path, '.github/workflows/ci.yml');
  });
});

describe('reviewDigest', () => {
  it('bounds the findings and their bodies, and counts them all', () => {
    const many = { ...review, findings: Array.from({ length: 30 }, (_, i) => ({ path: `f${i}.ts`, severity: 'low' as const, body: 'y'.repeat(1000) })) };
    const digest = reviewDigest(many);
    assert.equal(digest.findings.length, 20);
    assert.equal(digest.totalFindings, 30);
    assert.equal(digest.findings[0]!.body.length, 601);
    assert.ok(digest.findings[0]!.body.endsWith('…'));
  });
});
