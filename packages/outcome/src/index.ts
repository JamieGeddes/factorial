/**
 * Types and validation for the `Outcome` event (#165): what the pipeline
 * concluded about one turn. The orchestrator emits one per work item at its
 * terminal state; the reporter for the item's source type delivers it.
 *
 * The canonical contract is the JSON Schema at
 * `contracts/outcome/v1/outcome.schema.json`; the types here mirror it, and
 * validation always runs against the schema file.
 */
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

import schema from '../../../contracts/outcome/v1/outcome.schema.json' with { type: 'json' };

// ajv and ajv-formats are CommonJS. Under Node's ESM loader their default import is the
// module object, which also carries the class or function on `.default`.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

export const OUTCOME_SCHEMA_VERSION = 1 as const;
/** EventBridge envelope values: the orchestrator's outcome source, and the detail type. */
export const OUTCOME_EVENT_SOURCE = 'factorial.outcome' as const;
export const OUTCOME_DETAIL_TYPE = 'Outcome' as const;

export const OUTCOME_RESULTS = ['pr-opened', 'pr-updated', 'no-changes', 'tests-failed', 'invalid-plan', 'failed', 'refused'] as const;
export type OutcomeResult = (typeof OUTCOME_RESULTS)[number];

export const REFUSAL_REASONS = ['not-eligible', 'busy', 'rework-limit', 'covered-by-review'] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface Outcome {
  schemaVersion: typeof OUTCOME_SCHEMA_VERSION;
  workItemId: string;
  attempt: number;
  threadKey?: string;
  route?: 'change' | 'refuse';
  source: { type: string; id: string; url: string };
  inReplyTo?: { kind: 'pull-request'; number: number };
  repository: { provider: 'github'; owner: string; name: string };
  result: OutcomeResult;
  /** For `refused` only. */
  reason?: RefusalReason;
  at: string;
  /** `<workItemId>/<attempt>/`; its `report.json` carries what delivery needs. */
  artefactPrefix: string;
  pullRequest?: { number: number; url: string };
  branch?: string;
  /** On `pr-opened` and `pr-updated`. */
  testedSha?: string;
  savedWork?: { branch: string; commits?: number };
}

export type OutcomeValidationResult = { ok: true; value: Outcome } | { ok: false; errors: string[] };

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile<Outcome>(schema);

export function validateOutcome(input: unknown): OutcomeValidationResult {
  if (validate(input)) return { ok: true, value: input };
  return { ok: false, errors: (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? e.keyword}`) };
}
