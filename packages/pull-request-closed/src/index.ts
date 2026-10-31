/**
 * Types and validation for the `PullRequestClosed` event (#204): a pull
 * request Factorial opened was closed, merged or not. A trigger adapter emits
 * it and `factorial-thread-outcome` records it on the thread.
 *
 * The canonical contract is the JSON Schema at
 * `contracts/pull-request-closed/v1/pull-request-closed.schema.json`; the
 * types here mirror it, and validation always runs against the schema file.
 */
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

import schema from '../../../contracts/pull-request-closed/v1/pull-request-closed.schema.json' with { type: 'json' };

// ajv and ajv-formats are CommonJS. Under Node's ESM loader their default import is the
// module object, which also carries the class or function on `.default`.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

export const PULL_REQUEST_CLOSED_SCHEMA_VERSION = 1 as const;
/** EventBridge envelope values: the adapters' source, and this event's own detail type. */
export const PULL_REQUEST_CLOSED_EVENT_SOURCE = 'factorial.triggers' as const;
export const PULL_REQUEST_CLOSED_DETAIL_TYPE = 'PullRequestClosed' as const;

export interface PullRequestClosed {
  schemaVersion: typeof PULL_REQUEST_CLOSED_SCHEMA_VERSION;
  repository: { provider: 'github'; owner: string; name: string };
  number: number;
  url: string;
  /** A Factorial work branch, `factorial/<id>`: the thread's branch. */
  headBranch: string;
  merged: boolean;
  closedAt: string;
  /** When merged only. */
  mergedAt?: string;
  /** When merged only: the commit the merge made on the base branch. */
  mergeCommit?: string;
  /** Who merged it, or who closed it without merging. */
  by: string;
}

export type PullRequestClosedValidationResult = { ok: true; value: PullRequestClosed } | { ok: false; errors: string[] };

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile<PullRequestClosed>(schema);

export function validatePullRequestClosed(input: unknown): PullRequestClosedValidationResult {
  if (validate(input)) return { ok: true, value: input };
  return { ok: false, errors: (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? e.keyword}`) };
}
