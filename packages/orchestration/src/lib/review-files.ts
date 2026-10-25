/**
 * Moving the review between sessions. The reviewer's session is set up by the
 * orchestrator after the push, before the reviewer runs, so what is computed
 * there at seed time (the diff and the changed paths) can be trusted. Once the
 * reviewer has run, its session is hostile like the others: only
 * /workspace/review.json is read out, a regular file, capped in size by the
 * read itself, redacted and validated against the review contract.
 */
import { redactSecrets } from '@factorial/artefacts';
import {
  SENSITIVE_PATHS_FILE,
  parseReviewJson,
  parseSensitivePathsJson,
  type Review,
  type ReviewFinding,
  type ReviewScores,
  type ReviewVerdict,
  type SensitivePathRule,
} from '@factorial/review';

import { HARDENED_GIT_ENV, assertGitBranch, shellQuote } from './shell.ts';

export const MAX_REVIEW_FILE_BYTES = 64 * 1024;
/** The plan files are read back from the artefact store at most this large; CollectPlan capped them the same way. */
export const MAX_PLAN_ARTEFACT_BYTES = 64 * 1024;
const SECTION = '\n===FACTORIAL-REVIEW===\n';
/** At most this many validation errors are kept, each cut to ERROR_CHARS. */
const MAX_ERRORS = 10;
const ERROR_CHARS = 300;
/** At most this many sensitive paths travel in the state and the reviewer's prompt. */
const MAX_SENSITIVE = 20;

const encode = (text: string): string => shellQuote(Buffer.from(text, 'utf8').toString('base64'));

/** The rules file is read at most this large. */
export const MAX_RULES_FILE_BYTES = 64 * 1024;

/**
 * Write what the reviewer reads into its fresh session, then print the
 * changed paths and the repository's sensitive-path rules as they are on the
 * base branch, never as the branch under review has them, so a change cannot
 * loosen the rules that judge it. The paths are NUL-separated and
 * base64-encoded so no path can break the parse. The diff is three-dot,
 * against the merge base, so it shows what the pull request would change
 * even when the branch started from an earlier attempt. Rename detection is
 * off, so a file moved out of a sensitive directory is listed under its old
 * path as well as its new one.
 */
export function seedReviewScript(params: { baseBranch: string; planJson: string; planMarkdown: string; summary: string }): string {
  const base = `origin/${assertGitBranch(params.baseBranch, 'base branch')}`;
  const range = shellQuote(`${base}...HEAD`);
  const rules = shellQuote(`${base}:${SENSITIVE_PATHS_FILE}`);
  return [
    'set -euo pipefail',
    HARDENED_GIT_ENV,
    `printf '%s' ${encode(params.planJson)} | base64 -d > /workspace/plan.json`,
    `printf '%s' ${encode(params.planMarkdown)} | base64 -d > /workspace/plan.md`,
    `printf '%s' ${encode(params.summary)} | base64 -d > /workspace/summary.md`,
    'cd /workspace/repo',
    `git diff --no-color --no-ext-diff --no-textconv --text ${range} > /workspace/diff.patch`,
    `git diff -z --name-only --no-renames --no-ext-diff ${range} | base64 -w0`,
    `printf '%s' ${shellQuote(SECTION)}`,
    `if git cat-file -e ${rules} 2>/dev/null; then printf 'ok:'; git show ${rules} | head -c ${MAX_RULES_FILE_BYTES + 1} | base64 -w0; else printf 'missing:'; fi`,
  ].join('\n');
}

export interface ReviewSeed {
  changedPaths: string[];
  /** The base branch's rules file, if it has one. */
  rulesText?: string | undefined;
}

const decodePaths = (base64: string): string[] => {
  if (!/^[A-Za-z0-9+/=]*$/.test(base64)) throw new Error('review session did not produce base64 output');
  return Buffer.from(base64, 'base64').toString('utf8').split('\0').filter(Boolean);
};

export function parseReviewSeed(stdout: string): ReviewSeed {
  // Split before trimming: an empty first list leaves the marker's leading newline at the very start.
  const sections = stdout.split(SECTION);
  if (sections.length !== 2) throw new Error(`expected 2 sections from the review session, got ${sections.length}`);
  const changedPaths = decodePaths(sections[0]!.trim());
  const rules = sections[1]!.trim();
  if (rules === 'missing:') return { changedPaths };
  const match = /^ok:([A-Za-z0-9+/=]*)$/.exec(rules);
  if (!match) throw new Error('review session did not produce the rules file as base64');
  return { changedPaths, rulesText: Buffer.from(match[1]!, 'base64').toString('utf8') };
}

/**
 * Rules that hold in any repository on GitHub: Actions run with the
 * repository's secrets and can deploy, CODEOWNERS decides who must approve,
 * .gitattributes changes how git and GitHub show a diff, and .factorial/
 * holds these rules themselves.
 */
export const BUILT_IN_RULES: readonly SensitivePathRule[] = [
  { prefix: '.github/workflows/', reason: 'changes GitHub Actions, which run with the repository secrets and can deploy' },
  { prefix: '.github/actions/', reason: 'changes GitHub Actions, which run with the repository secrets and can deploy' },
  { path: 'CODEOWNERS', reason: 'changes who must approve changes' },
  { path: '.github/CODEOWNERS', reason: 'changes who must approve changes' },
  { path: 'docs/CODEOWNERS', reason: 'changes who must approve changes' },
  { name: '.gitattributes', reason: 'changes how git and GitHub treat files, which can hide changes from a diff' },
  { prefix: '.factorial/', reason: 'changes how Factorial treats this repository, including which changes are flagged for care' },
];

export interface SensitiveRules {
  rules: SensitivePathRule[];
  /** Why the repository's own rules were not used, if they were not. */
  problems: string[];
}

/**
 * The built-in rules, then the repository's own. A rules file that is too
 * large or invalid is reported and ignored; the built-in rules still apply.
 */
export function sensitiveRules(rulesText: string | undefined): SensitiveRules {
  if (rulesText === undefined) return { rules: [...BUILT_IN_RULES], problems: [] };
  if (Buffer.byteLength(rulesText, 'utf8') > MAX_RULES_FILE_BYTES) {
    return { rules: [...BUILT_IN_RULES], problems: [`${SENSITIVE_PATHS_FILE} is over the ${MAX_RULES_FILE_BYTES}-byte limit`] };
  }
  const parsed = parseSensitivePathsJson(rulesText);
  if (!parsed.ok) return { rules: [...BUILT_IN_RULES], problems: cut(parsed.errors.map((e) => `${SENSITIVE_PATHS_FILE} ${e}`)) };
  return { rules: [...BUILT_IN_RULES, ...parsed.value.rules], problems: [] };
}

/** The content patterns among the rules, in order. */
export const contentPatterns = (rules: readonly SensitivePathRule[]): string[] =>
  rules.flatMap((rule) => (rule.contentPattern === undefined ? [] : [rule.contentPattern]));

/**
 * For each content pattern, print the changed files whose added or removed
 * lines match it, in the same encoding as the seed, one section per pattern.
 * Run in the same fresh session as the seed, before the reviewer. --text
 * and --no-textconv stop the branch's .gitattributes marking a file binary
 * or converting it, which would hide its lines from the match.
 */
export function contentMatchScript(params: { baseBranch: string; patterns: readonly string[] }): string {
  const range = shellQuote(`origin/${assertGitBranch(params.baseBranch, 'base branch')}...HEAD`);
  return [
    'set -euo pipefail',
    HARDENED_GIT_ENV,
    'cd /workspace/repo',
    ...params.patterns.flatMap((pattern) => [
      `git diff -z --name-only --no-renames --no-ext-diff --no-textconv --text -G ${shellQuote(pattern)} ${range} | base64 -w0`,
      `printf '%s' ${shellQuote(SECTION)}`,
    ]),
  ].join('\n');
}

export function parseContentMatches(stdout: string, patterns: number): string[][] {
  const sections = stdout.split(SECTION);
  // Each pattern's list is followed by a marker, so the last section is what came after the final one.
  if (sections.length !== patterns + 1) throw new Error(`expected ${patterns} content match lists from the review session, got ${sections.length - 1}`);
  return sections.slice(0, patterns).map((section) => decodePaths(section.trim()));
}

export interface SensitiveChange {
  path: string;
  reason: string;
}

/**
 * The changed files a rule matches, each with the first matching rule's
 * reason. contentMatches holds, for each content pattern in rule order, the
 * files whose added or removed lines match it, so removing or swapping a
 * line is caught as well as editing one.
 */
export function sensitiveChanges(changedPaths: readonly string[], rules: readonly SensitivePathRule[], contentMatches: readonly string[][] = []): SensitiveChange[] {
  let next = 0;
  const matchers = rules.map((rule): ((path: string) => boolean) => {
    if (rule.path !== undefined) return (path) => path === rule.path;
    if (rule.prefix !== undefined) return (path) => path.startsWith(rule.prefix!);
    if (rule.name !== undefined) return (path) => path === rule.name || path.endsWith(`/${rule.name}`);
    const matched = new Set(contentMatches[next++] ?? []);
    return (path) => matched.has(path);
  });
  const changes: SensitiveChange[] = [];
  for (const path of changedPaths) {
    const index = matchers.findIndex((matches) => matches(path));
    if (index >= 0) changes.push({ path, reason: rules[index]!.reason });
  }
  return changes.slice(0, MAX_SENSITIVE);
}

/** ECS caps a task's overrides at 8 KiB, so the list for the reviewer's prompt stays well inside it. */
export const MAX_SENSITIVE_JSON_CHARS = 4096;

/**
 * The sensitive changes as JSON for the invoker's SENSITIVE_PATHS, as many as
 * fit the budget, in order. Any left out still get the orchestrator's finding
 * in CollectReview, which takes the full list from the state.
 */
export function sensitivePathsJson(changes: readonly SensitiveChange[]): string {
  const kept: SensitiveChange[] = [];
  for (const { path, reason } of changes) {
    if (JSON.stringify([...kept, { path, reason }]).length > MAX_SENSITIVE_JSON_CHARS) break;
    kept.push({ path, reason });
  }
  return JSON.stringify(kept);
}

/** Print review.json as `ok:<size>:<base64>` (the first MAX + 1 bytes, so an oversized file is detectable), or `missing:`. */
export function readReviewScript(): string {
  const path = shellQuote('/workspace/review.json');
  return [
    'set -uo pipefail',
    `if [ -f ${path} ] && [ ! -L ${path} ]; then printf 'ok:%s:' "$(stat -c %s -- ${path})"; head -c ${MAX_REVIEW_FILE_BYTES + 1} -- ${path} | base64 -w0; else printf 'missing:'; fi`,
    'exit 0',
  ].join('\n');
}

/** The size the session reported, or the bytes received if more: the session could lie about either. */
export function parseReviewRead(stdout: string): { text: string; size: number } | undefined {
  if (stdout.startsWith('missing:')) return undefined;
  const match = /^ok:([0-9]{1,12}):([A-Za-z0-9+/=]*)\s*$/.exec(stdout);
  if (!match) throw new Error('review export did not produce base64 output');
  const base64 = match[2] ?? '';
  if (base64.length > Math.ceil((MAX_REVIEW_FILE_BYTES + 1) / 3) * 4) return { text: '', size: Number.MAX_SAFE_INTEGER };
  const content = Buffer.from(base64, 'base64');
  return { text: content.toString('utf8'), size: Math.max(Number(match[1]), content.length) };
}

export type CheckedReview = { ok: true; review: Review; json: string } | { ok: false; errors: string[]; json?: string | undefined };

function cut(errors: string[]): string[] {
  return errors.slice(0, MAX_ERRORS).map((e) => (e.length > ERROR_CHARS ? `${e.slice(0, ERROR_CHARS)}…` : e));
}

/** Check what was read: present, within the cap and valid. Redacted before it is validated, so what is stored is what was checked. */
export function checkReviewFile(file: { text: string; size: number } | undefined): CheckedReview {
  if (!file) return { ok: false, errors: ['/workspace/review.json is missing'] };
  if (file.size > MAX_REVIEW_FILE_BYTES) return { ok: false, errors: [`/workspace/review.json is ${file.size} bytes, over the ${MAX_REVIEW_FILE_BYTES}-byte limit`] };
  const json = redactSecrets(file.text);
  const result = parseReviewJson(json);
  if (!result.ok) return { ok: false, errors: cut(result.errors.map((e) => `review.json ${e}`)), json };
  return { ok: true, review: result.value, json };
}

/**
 * Add a high-severity finding for every sensitive change, ahead of the
 * reviewer's own findings. This is a reminder for the human reviewer, not a
 * gate: the verdict is unchanged. It is added here, from paths computed
 * before the reviewer ran, because a reviewer can be talked out of it by the
 * text it reviews. It is added whatever the reviewer wrote about the same
 * path: a finding of its own, however worded, must never stand in for this.
 */
/** How the orchestrator's guard findings begin, so the pull request can tell them from the reviewer's own. */
export const GUARD_FINDING_PREFIX = 'Added by the orchestrator: ';

export function withGuardFindings(review: Review, changes: readonly SensitiveChange[]): { review: Review; added: number } {
  const guard: ReviewFinding[] = changes.map((change) => ({
      path: change.path,
      severity: 'high',
      body: `${GUARD_FINDING_PREFIX}this ${change.reason}. Review it with particular care; the automated review cannot clear it.`,
    }));
  // The contract allows at most 50 findings; the reviewer's least important go first.
  const findings = [...guard, ...review.findings].slice(0, 50);
  return { review: { ...review, findings }, added: guard.length };
}

/** The review as the state machine carries it to the pull request: bounded, whatever the review's size. */
export interface ReviewDigest {
  verdict: ReviewVerdict;
  scores: ReviewScores;
  summary: string;
  findings: ReviewFinding[];
  /** All findings, including those beyond the digest's. */
  totalFindings: number;
}

const DIGEST_FINDINGS = 20;
const DIGEST_BODY_CHARS = 600;

export function reviewDigest(review: Review): ReviewDigest {
  return {
    verdict: review.verdict,
    scores: review.scores,
    summary: review.summary,
    findings: review.findings.slice(0, DIGEST_FINDINGS).map((f) => ({
      ...f,
      body: f.body.length > DIGEST_BODY_CHARS ? `${f.body.slice(0, DIGEST_BODY_CHARS)}…` : f.body,
    })),
    totalFindings: review.findings.length,
  };
}
