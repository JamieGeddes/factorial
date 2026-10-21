/**
 * Moving the review between sessions. The reviewer's session is set up by the
 * orchestrator after the push, before the reviewer runs, so what is computed
 * there at seed time (the diff and the changed paths) can be trusted. Once the
 * reviewer has run, its session is hostile like the others: only
 * /workspace/review.json is read out, a regular file, capped in size by the
 * read itself, redacted and validated against the review contract.
 */
import { redactSecrets } from '@factorial/artefacts';
import { parseReviewJson, type Review, type ReviewFinding, type ReviewScores, type ReviewVerdict } from '@factorial/review';

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

/**
 * Write what the reviewer reads into its fresh session, then print the
 * changed paths and the paths whose diff touches a permissions boundary,
 * NUL-separated and base64-encoded so no path can break the parse. The diff
 * is three-dot, against the merge base, so it shows what the pull request
 * would change even when the branch started from an earlier attempt.
 * Rename detection is off, so a file moved out of a sensitive directory is
 * listed under its old path as well as its new one.
 */
export function seedReviewScript(params: { baseBranch: string; planJson: string; planMarkdown: string; summary: string }): string {
  const range = shellQuote(`origin/${assertGitBranch(params.baseBranch, 'base branch')}...HEAD`);
  return [
    'set -euo pipefail',
    HARDENED_GIT_ENV,
    `printf '%s' ${encode(params.planJson)} | base64 -d > /workspace/plan.json`,
    `printf '%s' ${encode(params.planMarkdown)} | base64 -d > /workspace/plan.md`,
    `printf '%s' ${encode(params.summary)} | base64 -d > /workspace/summary.md`,
    'cd /workspace/repo',
    `git diff --no-color --no-ext-diff ${range} > /workspace/diff.patch`,
    `git diff -z --name-only --no-renames --no-ext-diff ${range} | base64 -w0`,
    `printf '%s' ${shellQuote(SECTION)}`,
    `git diff -z --name-only --no-renames --no-ext-diff -G '[Pp]ermissions-?[Bb]oundary' ${range} | base64 -w0`,
  ].join('\n');
}

export interface ReviewSeed {
  changedPaths: string[];
  /** Changed files whose added or removed lines mention a permissions boundary. */
  boundaryPaths: string[];
}

export function parseReviewSeed(stdout: string): ReviewSeed {
  // Split before trimming: an empty first list leaves the marker's leading newline at the very start.
  const sections = stdout.split(SECTION);
  if (sections.length !== 2) throw new Error(`expected 2 path lists from the review session, got ${sections.length}`);
  const [changedPaths, boundaryPaths] = sections.map((section) => {
    const base64 = section.trim();
    if (!/^[A-Za-z0-9+/=]*$/.test(base64)) throw new Error('review seed did not produce base64 output');
    return Buffer.from(base64, 'base64').toString('utf8').split('\0').filter(Boolean);
  });
  return { changedPaths: changedPaths ?? [], boundaryPaths: boundaryPaths ?? [] };
}

export interface SensitiveChange {
  path: string;
  reason: string;
}

/**
 * Changes to what deploys Factorial or limits it: Actions workflows and the
 * composite actions they run, the foundation stack and permissions
 * boundaries. Boundaries are matched on added or removed lines, so removing
 * or swapping a role's boundary is caught as well as editing one. The foundation and boundary
 * rules name Factorial's own files, so in another repository only workflows
 * are likely to match, which deserve the same care there.
 */
export function sensitiveChanges(seed: ReviewSeed): SensitiveChange[] {
  const boundary = new Set(seed.boundaryPaths);
  const changes: SensitiveChange[] = [];
  for (const path of seed.changedPaths) {
    if (path.startsWith('.github/workflows/') || path.startsWith('.github/actions/')) {
      changes.push({ path, reason: 'changes GitHub Actions, which run with the repository secrets and can deploy' });
    } else if (path === 'templates/00-foundation.yml') {
      changes.push({ path, reason: 'changes the foundation stack, which holds the deploy role, the CloudFormation execution role and the permissions boundaries' });
    } else if (boundary.has(path)) {
      changes.push({ path, reason: 'changes a permissions boundary or what carries one' });
    }
  }
  return changes.slice(0, MAX_SENSITIVE);
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
export function withGuardFindings(review: Review, changes: readonly SensitiveChange[]): { review: Review; added: number } {
  const guard: ReviewFinding[] = changes.map((change) => ({
      path: change.path,
      severity: 'high',
      body: `Added by the orchestrator: this ${change.reason}. Review it with particular care; the automated review cannot clear it.`,
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
