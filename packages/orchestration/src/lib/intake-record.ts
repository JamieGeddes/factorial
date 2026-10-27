/**
 * The intake record (`contracts/intake/v1/`): what Intake decided about one
 * WorkItem. Validated against the schema before it is stored or returned to
 * the state machine, which acts on its route.
 */
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import schema from '../../../../contracts/intake/v1/intake.schema.json' with { type: 'json' };

// ajv and ajv-formats are CommonJS. Under Node's ESM loader their default import is the
// module object, which also carries the class or function on `.default`.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

export const ROUTES = ['change', 'refuse'] as const;
export type Route = (typeof ROUTES)[number];

export type RefusalStatus = 'not-eligible' | 'busy' | 'rework-limit' | 'covered-by-review';

export interface IntakeRecord {
  schemaVersion: 1;
  workItemId: string;
  route: Route;
  turn: 'new' | 'resume' | 'rework';
  reason: string;
  threadKey?: string;
  branch?: string;
  pullRequest?: number;
  cause?: 'review' | 'checks-failed' | 'comment';
  previousWorkItemId?: string;
  resumedFrom?: string;
  refusal?: { status: RefusalStatus; replied: boolean };
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile<IntakeRecord>(schema);

export class InvalidIntakeRecordError extends Error {
  constructor(errors: string[]) {
    super(`Invalid intake record: ${errors.join('; ')}`);
    this.name = 'InvalidIntakeRecord';
  }
}

/** Validate a record, throwing with every problem when it does not fit the schema. */
export function assertIntakeRecord(record: unknown): asserts record is IntakeRecord {
  if (validate(record)) return;
  throw new InvalidIntakeRecordError((validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? e.keyword}`));
}
