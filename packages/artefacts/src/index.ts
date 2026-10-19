/**
 * The artefact store: everything a run produces, kept under one key per
 * attempt, `<workItemId>/<attempt>/`. The bucket is versioned and refuses
 * deletes, so a retried stage overwrites its key and the earlier version stays.
 * Text is redacted before it leaves the account's own services. Shared by the
 * orchestrator Lambdas and the invoker, the only writers.
 */
import { PutObjectCommand, S3Client, type PutObjectCommandInput } from '@aws-sdk/client-s3';

import { redactSecrets } from './redact.ts';

export { redactSecrets } from './redact.ts';

const s3 = new S3Client({});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ARTEFACT_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const PREFIX = /^([0-9a-f-]{36})\/([1-9][0-9]*)\/$/;

function assertUuid(value: string): string {
  if (!UUID.test(value)) throw new Error(`WorkItem id "${value}" is not a UUID`);
  return value;
}

function artefactBucket(): string {
  const bucket = process.env.ARTEFACT_BUCKET;
  if (!bucket) throw new Error('Missing required environment variable ARTEFACT_BUCKET');
  return bucket;
}

/** The key prefix for one attempt at a work item. */
export function artefactPrefix(workItemId: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`attempt ${attempt} is not a positive integer`);
  }
  return `${assertUuid(workItemId)}/${attempt}/`;
}

/** The object key for a stage file, e.g. `prepare/branch.json`, under an attempt's prefix. */
export function artefactKey(prefix: string, path: string): string {
  const match = PREFIX.exec(prefix);
  if (!match) throw new Error(`"${prefix}" is not an artefact prefix`);
  assertUuid(match[1] ?? '');
  if (!ARTEFACT_PATH.test(path) || path.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`"${path}" is not a valid artefact path`);
  }
  return `${prefix}${path}`;
}

/** The upload for one text artefact, its text redacted. */
export function artefactObject(
  bucket: string,
  prefix: string,
  path: string,
  body: string,
  contentType: string,
): PutObjectCommandInput {
  return {
    Bucket: bucket,
    Key: artefactKey(prefix, path),
    Body: redactSecrets(body),
    ContentType: contentType,
  };
}

/** Store one text artefact, redacted. Idempotent: a retry overwrites the same key, which versioning records. */
export async function putArtefact(prefix: string, path: string, body: string, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand(artefactObject(artefactBucket(), prefix, path, body, contentType)));
}

export async function putJsonArtefact(prefix: string, path: string, value: unknown): Promise<void> {
  await putArtefact(prefix, path, `${JSON.stringify(value, null, 2)}\n`, 'application/json');
}

/**
 * Store one binary artefact as is. Only for data that cannot hold redactable
 * text in a meaningful sense, such as the git bundle, whose content is what
 * will be pushed anyway.
 */
export async function putBinaryArtefact(prefix: string, path: string, body: Uint8Array, contentType: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({ Bucket: artefactBucket(), Key: artefactKey(prefix, path), Body: body, ContentType: contentType }),
  );
}
