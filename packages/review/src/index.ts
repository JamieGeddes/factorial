/**
 * Types and validation for the review contract: the reviewer's judgement of
 * a change against its request and plan.
 *
 * The canonical contract is the JSON Schema at `contracts/review/v1/review.schema.json`.
 * The types here mirror it for convenience; validation always runs against the schema file,
 * so the schema wins if the two ever disagree.
 */
import Ajv2020Module from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import addFormatsModule from 'ajv-formats';
import schema from '../../../contracts/review/v1/review.schema.json' with { type: 'json' };
import sensitivePathsSchema from '../../../contracts/review/v1/sensitive-paths.schema.json' with { type: 'json' };

// ajv and ajv-formats are CommonJS. Under Node's ESM loader their default import is the
// module object, which also carries the class or function on `.default`.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

/** Contract version implemented by this package. */
export const REVIEW_SCHEMA_VERSION = 1 as const;

export const REVIEW_VERDICTS = ['approve', 'request-changes', 'comment'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export const REVIEW_SEVERITIES = ['high', 'medium', 'low'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

/** Each score is an integer from 1 (poor) to 5 (excellent). */
export interface ReviewScores {
  correctness: number;
  completeness: number;
  tests: number;
  safety: number;
}

export interface ReviewFinding {
  /** Repository-relative path the finding is about. */
  path: string;
  /** Line in the file at the branch head, when the finding is about one place. */
  line?: number;
  severity: ReviewSeverity;
  body: string;
}

export interface Review {
  schemaVersion: typeof REVIEW_SCHEMA_VERSION;
  verdict: ReviewVerdict;
  scores: ReviewScores;
  /** Most important first. */
  findings: ReviewFinding[];
  summary: string;
}

/**
 * One of a target repository's rules for changes that need particular care.
 * Exactly one of path, prefix or contentPattern is set.
 */
export interface SensitivePathRule {
  path?: string;
  prefix?: string;
  /** POSIX extended regular expression, matched against added and removed lines (git diff -G). */
  contentPattern?: string;
  /** Completes "This change ...". */
  reason: string;
}

/** A target repository's `.factorial/sensitive-paths.json`. */
export interface SensitivePaths {
  schemaVersion: 1;
  rules: SensitivePathRule[];
}

/** Where a target repository keeps its sensitive-path rules. */
export const SENSITIVE_PATHS_FILE = '.factorial/sensitive-paths.json';

export type ReviewValidationResult = { ok: true; value: Review } | { ok: false; errors: string[] };

export class ReviewValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Invalid review: ${errors.join('; ')}`);
    this.name = 'ReviewValidationError';
    this.errors = errors;
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile<Review>(schema);
const validateSensitive = ajv.compile<SensitivePaths>(sensitivePathsSchema);

function describe(error: ErrorObject): string {
  const path = error.instancePath === '' ? '(root)' : error.instancePath;
  if (error.keyword === 'additionalProperties') {
    const extra = (error.params as { additionalProperty?: string }).additionalProperty;
    return `${path} has unexpected property "${extra ?? '?'}"`;
  }
  return `${path} ${error.message ?? error.keyword}`;
}

/** Validate an unknown value against the review schema without throwing. */
export function validateReview(input: unknown): ReviewValidationResult {
  if (validate(input)) return { ok: true, value: input };
  return { ok: false, errors: (validate.errors ?? []).map(describe) };
}

/** Validate an unknown value against the review schema, throwing on failure. */
export function assertReview(input: unknown): asserts input is Review {
  const result = validateReview(input);
  if (!result.ok) throw new ReviewValidationError(result.errors);
}

/** Parse review.json text and validate it, so a syntax error reads like any other problem. */
export function parseReviewJson(text: string): ReviewValidationResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`(root) is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return validateReview(value);
}

/** Parse and validate a repository's sensitive-path rules without throwing. */
export function parseSensitivePathsJson(text: string): { ok: true; value: SensitivePaths } | { ok: false; errors: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`(root) is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (validateSensitive(value)) return { ok: true, value };
  return { ok: false, errors: (validateSensitive.errors ?? []).map(describe) };
}
