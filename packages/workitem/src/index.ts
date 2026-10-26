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
  /** An event on a pull request Factorial opened: a review, a comment addressed to it, or failed checks. `source.id` is the pull request number. */
  githubPullRequest: 'github-pull-request',
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

/** Why rework of a previous WorkItem is needed. */
export type WorkItemReworkCause = 'review' | 'checks-failed';

export interface WorkItemReviewDetail {
  /** Author of the comment, as a source-system login. */
  author: string;
  /** Optional file the comment applies to. */
  path?: string;
  /** Optional line the comment applies to. */
  line?: number;
  /** The comment text, at most 8,000 characters. */
  body: string;
}

/** Context about a rework of a previous WorkItem's pull request. */
export interface ReworkContext {
  kind: 'rework';
  pullRequest: {
    number: number;
    url: string;
  };
  /** The Factorial working branch the pull request was raised from. */
  branch: string;
  /** The branch the pull request targets. */
  baseBranch: string;
  /** The id of the WorkItem that produced the pull request being reworked. */
  previousWorkItemId: string;
  cause: WorkItemReworkCause;
  /** The specific items to address, e.g. review comments. At most 50. */
  details: WorkItemReviewDetail[];
}

/** Discriminated union over `context.kind`. Only rework exists today. */
export type WorkItemContext = ReworkContext;

/** The set of WorkItems one trigger produced. */
export interface WorkItemGroup {
  /** Shared by every WorkItem in the set. */
  id: string;
  /** How many WorkItems the set holds. */
  size: number;
  /** This WorkItem's position in the set, from 1 to `size`. */
  index: number;
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
  /** Optional: the set of WorkItems one trigger produced. */
  group?: WorkItemGroup;
  /** Optional: the WorkItem whose Plan stage emitted this one. */
  parentId?: string;
  /** Optional structured context. A consumer that ignores it still has `body`. */
  context?: WorkItemContext;
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

/** Rules the schema states but cannot express, because they compare two fields. */
function crossFieldErrors(item: WorkItem): string[] {
  if (item.group && item.group.index > item.group.size) {
    return [`/group/index must not exceed /group/size (${item.group.index} > ${item.group.size})`];
  }
  return [];
}

/** Validate an unknown value against the WorkItem schema without throwing. */
export function validateWorkItem(input: unknown): WorkItemValidationResult {
  if (validate(input)) {
    const errors = crossFieldErrors(input);
    return errors.length === 0 ? { ok: true, value: input } : { ok: false, errors };
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
