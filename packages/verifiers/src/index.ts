/**
 * Types and validation for the verifier contracts (#167): the checks a target
 * declares in `.factorial/verifiers.json`, and the result of running one.
 *
 * The canonical contracts are the JSON Schemas in `contracts/verifiers/v1/`.
 * The types here mirror them; validation always runs against the schema files,
 * so the schemas win if the two ever disagree.
 */
import Ajv2020Module from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import addFormatsModule from 'ajv-formats';

import resultSchema from '../../../contracts/verifiers/v1/result.schema.json' with { type: 'json' };
import settingsSchema from '../../../contracts/verifiers/v1/verifiers.schema.json' with { type: 'json' };

import type { VerifierResult, VerifierSettings } from './types.ts';

export { VERIFIER_OUTCOMES, type Verifier, type VerifierOutcome, type VerifierResult, type VerifierSettings } from './types.ts';
export { KILL_AFTER_SECONDS, SETUP_FAILED, VERIFIER_CONTAINER, outcomeOf } from './exit.ts';

// ajv and ajv-formats are CommonJS. Under Node's ESM loader their default import is the
// module object, which also carries the class or function on `.default`.
const Ajv2020 = Ajv2020Module.default;
const addFormats = addFormatsModule.default;

/** Where a target repository declares its verifiers, read from its base branch. */
export const VERIFIERS_FILE = '.factorial/verifiers.json';

/** The most bytes of the settings file read: far beyond ten verifiers. */
export const MAX_VERIFIERS_FILE_BYTES = 64 * 1024;

export type Validated<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateSettingsSchema = ajv.compile<VerifierSettings>(settingsSchema);
const validateResultSchema = ajv.compile<VerifierResult>(resultSchema);

function describe(error: ErrorObject): string {
  const path = error.instancePath === '' ? '(root)' : error.instancePath;
  if (error.keyword === 'additionalProperties') {
    const extra = (error.params as { additionalProperty?: string }).additionalProperty;
    return `${path} has unexpected property "${extra ?? '?'}"`;
  }
  return `${path} ${error.message ?? error.keyword}`;
}

/** Validate a parsed settings file: the schema, then what a schema cannot say (unique names). */
export function validateVerifierSettings(input: unknown): Validated<VerifierSettings> {
  if (!validateSettingsSchema(input)) return { ok: false, errors: (validateSettingsSchema.errors ?? []).map(describe) };
  const seen = new Set<string>();
  const errors: string[] = [];
  input.verifiers.forEach((verifier, i) => {
    if (seen.has(verifier.name)) errors.push(`/verifiers/${i}/name "${verifier.name}" is used by an earlier verifier`);
    seen.add(verifier.name);
  });
  return errors.length === 0 ? { ok: true, value: input } : { ok: false, errors };
}

/** Parse and validate `.factorial/verifiers.json` text, so a syntax error reads like any other problem. */
export function parseVerifierSettings(text: string): Validated<VerifierSettings> {
  if (Buffer.byteLength(text, 'utf8') > MAX_VERIFIERS_FILE_BYTES) return { ok: false, errors: [`(root) is over ${MAX_VERIFIERS_FILE_BYTES} bytes`] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`(root) is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return validateVerifierSettings(value);
}

export function validateVerifierResult(input: unknown): Validated<VerifierResult> {
  if (validateResultSchema(input)) return { ok: true, value: input };
  return { ok: false, errors: (validateResultSchema.errors ?? []).map(describe) };
}

/** Parse and validate a stored `result.json`. */
export function parseVerifierResult(text: string): Validated<VerifierResult> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`(root) is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return validateVerifierResult(value);
}

/** A verifier's directory under the attempt's artefact prefix. */
export const verifierPath = (name: string, file: 'result.json' | 'output.log'): string => `verify/${name}/${file}`;
