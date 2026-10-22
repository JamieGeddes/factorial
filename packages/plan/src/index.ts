/**
 * Types and validation for the plan contract: what the planner decided to
 * change and how to verify it.
 *
 * The canonical contract is the JSON Schema at `contracts/plan/v1/plan.schema.json`.
 * The types here mirror it for convenience; validation always runs against the schema file,
 * so the schema wins if the two ever disagree.
 */
import Ajv2020Module from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import addFormatsModule from 'ajv-formats';
import schema from '../../../contracts/plan/v1/plan.schema.json' with { type: 'json' };

// ajv and ajv-formats are CommonJS. Under Node's ESM loader their default import is the
// module object, which also carries the class or function on `.default`.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

/** Contract version implemented by this package. */
export const PLAN_SCHEMA_VERSION = 1 as const;

export interface PlanStep {
  /** Short identifier the builder uses to report on the step. */
  id: string;
  description: string;
  /** Repository-relative paths the step creates or changes. */
  files: string[];
  /** How the builder confirms the step is done. */
  verification: string;
}

export interface Plan {
  schemaVersion: typeof PLAN_SCHEMA_VERSION;
  summary: string;
  steps: PlanStep[];
  tests: {
    /** Commands to run once the change is made. */
    run: string[];
    /** Tests to add or change, one sentence each. */
    add: string[];
  };
  risks: string[];
  /** What the request leaves undecided, and the assumption made for each. */
  openQuestions: string[];
  /** Work the request asks for that the plan leaves for a later item, so one builder run can finish it. */
  followUp?: string[];
}

export type PlanValidationResult = { ok: true; value: Plan } | { ok: false; errors: string[] };

export class PlanValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Invalid plan: ${errors.join('; ')}`);
    this.name = 'PlanValidationError';
    this.errors = errors;
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile<Plan>(schema);

function describe(error: ErrorObject): string {
  const path = error.instancePath === '' ? '(root)' : error.instancePath;
  if (error.keyword === 'additionalProperties') {
    const extra = (error.params as { additionalProperty?: string }).additionalProperty;
    return `${path} has unexpected property "${extra ?? '?'}"`;
  }
  return `${path} ${error.message ?? error.keyword}`;
}

/** Rules the schema states but cannot express. */
function crossFieldErrors(plan: Plan): string[] {
  const seen = new Set<string>();
  const errors: string[] = [];
  plan.steps.forEach((step, i) => {
    if (seen.has(step.id)) errors.push(`/steps/${i}/id "${step.id}" is used by an earlier step`);
    seen.add(step.id);
  });
  return errors;
}

/** Validate an unknown value against the plan schema without throwing. */
export function validatePlan(input: unknown): PlanValidationResult {
  if (validate(input)) {
    const errors = crossFieldErrors(input);
    return errors.length === 0 ? { ok: true, value: input } : { ok: false, errors };
  }
  return { ok: false, errors: (validate.errors ?? []).map(describe) };
}

/** Validate an unknown value against the plan schema, throwing on failure. */
export function assertPlan(input: unknown): asserts input is Plan {
  const result = validatePlan(input);
  if (!result.ok) throw new PlanValidationError(result.errors);
}

/** Parse plan.json text and validate it, so a syntax error reads like any other problem. */
export function parsePlanJson(text: string): PlanValidationResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`(root) is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return validatePlan(value);
}
