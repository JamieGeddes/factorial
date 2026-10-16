/**
 * Types and validation for the Factorial `WorkItem` contract.
 *
 * The canonical contract is the JSON Schema at `contracts/workitem/v1/workitem.schema.json`.
 * The types here mirror it for convenience; validation always runs against the schema file,
 * so the schema wins if the two ever disagree.
 */
import Ajv2020Module from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import addFormatsModule from 'ajv-formats';
import schema from '../../../contracts/workitem/v1/workitem.schema.json' with { type: 'json' };

// ajv and ajv-formats are CommonJS. Under Node's ESM loader their default import is the
// module object, which also carries the class or function on `.default`.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

/** Contract version implemented by this package. */
export const WORKITEM_SCHEMA_VERSION = 1 as const;

/** EventBridge envelope values used to route WorkItems. */
export const WORKITEM_EVENT_SOURCE = 'factorial.triggers' as const;
export const WORKITEM_DETAIL_TYPE = 'WorkItem' as const;

/** Trigger types known to this version of Factorial. The schema accepts any kebab-case value. */
export const TRIGGER_TYPES = {
  githubIssue: 'github-issue',
} as const;

export interface WorkItemSource {
  /** Trigger type in kebab-case, e.g. `github-issue`. */
  type: string;
  /** Identifier within the source system, e.g. the issue number. */
  id: string;
  /** Link back to the originating record. */
  url: string;
}

export interface WorkItemRepository {
  provider: 'github';
  owner: string;
  name: string;
}

export interface WorkItem {
  schemaVersion: typeof WORKITEM_SCHEMA_VERSION;
  id: string;
  source: WorkItemSource;
  repository: WorkItemRepository;
  title: string;
  body: string;
  requestedBy: string;
  /** RFC 3339 timestamp. */
  createdAt: string;
}

export type WorkItemValidationResult =
  | { ok: true; value: WorkItem }
  | { ok: false; errors: string[] };

export class WorkItemValidationError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Invalid WorkItem: ${errors.join('; ')}`);
    this.name = 'WorkItemValidationError';
    this.errors = errors;
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile<WorkItem>(schema);

function describe(error: ErrorObject): string {
  const path = error.instancePath === '' ? '(root)' : error.instancePath;
  if (error.keyword === 'additionalProperties') {
    const extra = (error.params as { additionalProperty?: string }).additionalProperty;
    return `${path} has unexpected property "${extra ?? '?'}"`;
  }
  return `${path} ${error.message ?? error.keyword}`;
}

/** Validate an unknown value against the WorkItem schema without throwing. */
export function validateWorkItem(input: unknown): WorkItemValidationResult {
  if (validate(input)) {
    return { ok: true, value: input };
  }
  const errors = (validate.errors ?? []).map(describe);
  return { ok: false, errors };
}

/** Validate an unknown value against the WorkItem schema, throwing on failure. */
export function assertWorkItem(input: unknown): asserts input is WorkItem {
  const result = validateWorkItem(input);
  if (!result.ok) {
    throw new WorkItemValidationError(result.errors);
  }
}

/** Convenience for callers that want the typed value or an exception. */
export function parseWorkItem(input: unknown): WorkItem {
  assertWorkItem(input);
  return input;
}
