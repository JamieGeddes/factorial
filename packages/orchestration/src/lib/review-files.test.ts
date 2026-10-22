import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Review } from '@factorial/review';

import {
  BUILT_IN_RULES,
  MAX_REVIEW_FILE_BYTES,
  MAX_RULES_FILE_BYTES,
  MAX_SENSITIVE_JSON_CHARS,
  checkReviewFile,
  contentMatchScript,
  contentPatterns,
  parseContentMatches,
  parseReviewRead,
  parseReviewSeed,
  readReviewScript,
  reviewDigest,
  seedReviewScript,
  sensitiveChanges,
  sensitivePathsJson,
  sensitiveRules,
  withGuardFindings,
} from './review-files.ts';
import { shellQuote } from './shell.ts';

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
    assert.match(script, /--name-only --no-renames/);
    assert.match(script, /GIT_CONFIG_GLOBAL=\/dev\/null/);
  });

  it('reads the rules from the base branch, not the branch under review', () => {
    const script = seedReviewScript({ baseBranch: 'main', planJson: '{}', planMarkdown: '', summary: '' });
    assert.match(script, /git cat-file -e 'origin\/main:\.factorial\/sensitive-paths\.json'/);
    assert.match(script, /git show 'origin\/main:\.factorial\/sensitive-paths\.json' \| head -c 65537/);
    assert.doesNotMatch(script, /HEAD:\.factorial|cat [^|]*\.factorial/);
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
  const rules = Buffer.from('{"schemaVersion":1,"rules":[]}', 'utf8').toString('base64');

  it('reads the NUL-separated paths and the rules file', () => {
    const seed = parseReviewSeed(`${nulList(['a.ts', 'dir/with space.ts', 'new\nline.ts'])}${SECTION}ok:${rules}\n`);
    assert.deepEqual(seed, { changedPaths: ['a.ts', 'dir/with space.ts', 'new\nline.ts'], rulesText: '{"schemaVersion":1,"rules":[]}' });
  });

  it('reads an empty list and a missing rules file', () => {
    assert.deepEqual(parseReviewSeed(`${SECTION}missing:`), { changedPaths: [] });
  });

  it('refuses output that is not two base64 sections', () => {
    assert.throws(() => parseReviewSeed('abc'), /expected 2 sections/);
    assert.throws(() => parseReviewSeed(`not base64!${SECTION}missing:`), /base64/);
    assert.throws(() => parseReviewSeed(`${SECTION}ok:not base64!`), /rules file/);
  });
});

describe('sensitiveRules', () => {
  it('uses only the built-in rules when the repository has none', () => {
    assert.deepEqual(sensitiveRules(undefined), { rules: [...BUILT_IN_RULES], problems: [] });
  });

  it("adds the repository's rules after the built-in ones", () => {
    const own = { path: 'infra/iam.yml', reason: 'changes IAM' };
    const { rules, problems } = sensitiveRules(JSON.stringify({ schemaVersion: 1, rules: [own] }));
    assert.deepEqual(rules, [...BUILT_IN_RULES, own]);
    assert.deepEqual(problems, []);
  });

  it('reports and ignores invalid or oversized rules, keeping the built-in ones', () => {
    for (const text of ['{', JSON.stringify({ schemaVersion: 1, rules: [{ reason: 'r' }] }), 'x'.repeat(MAX_RULES_FILE_BYTES + 1)]) {
      const { rules, problems } = sensitiveRules(text);
      assert.deepEqual(rules, [...BUILT_IN_RULES]);
      assert.ok(problems.length > 0 && problems.every((p) => p.startsWith('.factorial/sensitive-paths.json')));
    }
  });
});

describe('content patterns', () => {
  it('quotes each pattern and diffs against the base branch without renames', () => {
    const hostile = "'; touch /x; '";
    const script = contentMatchScript({ baseBranch: 'main', patterns: ['iam:PassRole', hostile] });
    assert.match(script, /git diff -z --name-only --no-renames --no-ext-diff -G 'iam:PassRole' 'origin\/main\.\.\.HEAD'/);
    assert.ok(script.includes(`-G ${shellQuote(hostile)} `));
    assert.equal(script.match(/===FACTORIAL-REVIEW===/g)?.length, 2);
  });

  it('reads one list per pattern', () => {
    assert.deepEqual(parseContentMatches(`${nulList(['a.yml'])}${SECTION}${SECTION}`, 2), [['a.yml'], []]);
    assert.throws(() => parseContentMatches(`${nulList(['a.yml'])}${SECTION}`, 2), /expected 2/);
  });

  it('lists the content patterns in rule order', () => {
    assert.deepEqual(contentPatterns([{ path: 'a', reason: 'r' }, { contentPattern: 'x', reason: 'r' }, { contentPattern: 'y', reason: 'r' }]), ['x', 'y']);
  });
});

describe('sensitiveChanges', () => {
  const rules = [
    ...BUILT_IN_RULES,
    { path: 'templates/00-foundation.yml', reason: 'changes the foundation stack' },
    { prefix: 'infra/', reason: 'changes infrastructure' },
    { contentPattern: '[Pp]ermissions-?[Bb]oundary', reason: 'changes a permissions boundary or what carries one' },
  ];

  it('flags what the built-in and repository rules match, and nothing else', () => {
    const changes = sensitiveChanges(
      ['src/a.ts', '.github/workflows/ci.yml', '.github/actions/classify/action.yml', '.github/CODEOWNERS', '.factorial/sensitive-paths.json', 'templates/00-foundation.yml', 'infra/db.yml', 'templates/20-agent.yml', 'docs/a.md'],
      rules,
      [['templates/20-agent.yml']],
    );
    assert.deepEqual(changes.map((c) => c.path), [
      '.github/workflows/ci.yml',
      '.github/actions/classify/action.yml',
      '.github/CODEOWNERS',
      '.factorial/sensitive-paths.json',
      'templates/00-foundation.yml',
      'infra/db.yml',
      'templates/20-agent.yml',
    ]);
    assert.match(changes[0]!.reason, /GitHub Actions/);
    assert.match(changes[2]!.reason, /approve/);
    assert.match(changes[3]!.reason, /flagged for care/);
    assert.match(changes[6]!.reason, /permissions boundary/);
  });

  it('flags only Actions, ownership and Factorial configuration by default, whatever the repository', () => {
    assert.deepEqual(sensitiveChanges(['templates/00-foundation.yml', 'src/a.ts'], BUILT_IN_RULES), []);
  });

  it("gives the first matching rule's reason", () => {
    const changes = sensitiveChanges(['infra/x.yml'], [...rules, { path: 'infra/x.yml', reason: 'later' }]);
    assert.equal(changes[0]!.reason, 'changes infrastructure');
  });

  it('ignores a content match that is not among the changed paths', () => {
    assert.deepEqual(sensitiveChanges(['src/a.ts'], rules, [['templates/x.yml']]), []);
  });

  it('keeps at most 20', () => {
    const changedPaths = Array.from({ length: 30 }, (_, i) => `.github/workflows/w${i}.yml`);
    assert.equal(sensitiveChanges(changedPaths, BUILT_IN_RULES).length, 20);
  });
});

describe('sensitivePathsJson', () => {
  it('passes paths with their reasons', () => {
    const changes = [{ path: '.github/workflows/ci.yml', reason: 'changes GitHub Actions' }];
    assert.deepEqual(JSON.parse(sensitivePathsJson(changes)), changes);
  });

  it('keeps the list within its budget, in order', () => {
    const changes = Array.from({ length: 20 }, (_, i) => ({ path: `${'d/'.repeat(100)}f${i}`, reason: 'r'.repeat(200) }));
    const json = sensitivePathsJson(changes);
    assert.ok(json.length <= MAX_SENSITIVE_JSON_CHARS);
    const kept = JSON.parse(json) as typeof changes;
    assert.ok(kept.length > 0 && kept.length < 20);
    assert.deepEqual(kept, changes.slice(0, kept.length));
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
