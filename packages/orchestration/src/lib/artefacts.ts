/**
 * The artefact store: everything a run produces, kept under one key per
 * attempt, `<workItemId>/<attempt>/`. The bucket is versioned and refuses
 * deletes, so a retried stage overwrites its key and the earlier version stays.
 * Text is redacted before it leaves the account's own services.
 */
import { PutObjectCommand, S3Client, type PutObjectCommandInput } from '@aws-sdk/client-s3';

import { requireEnv } from './env.ts';
import { assertUuid, redactSecrets } from './shell.ts';

const s3 = new S3Client({});

const ARTEFACT_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const PREFIX = /^([0-9a-f-]{36})\/([1-9][0-9]*)\/$/;

/** The key prefix for one attempt at a work item. */
export function artefactPrefix(workItemId: string, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`attempt ${attempt} is not a positive integer`);
  }
  return `${assertUuid(workItemId, 'WorkItem id')}/${attempt}/`;
}

/** The object key for a stage file, e.g. `prepare/branch.json`, under an attempt's prefix. */
export function artefactKey(prefix: string, path: string): string {
  const match = PREFIX.exec(prefix);
  if (!match) throw new Error(`"${prefix}" is not an artefact prefix`);
  assertUuid(match[1] ?? '', 'WorkItem id');
  if (!ARTEFACT_PATH.test(path) || path.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`"${path}" is not a valid artefact path`);
  }
  return `${prefix}${path}`;
}

/** Where a reviewer finds an attempt's record. */
export function artefactUri(prefix: string, bucket = requireEnv('ARTEFACT_BUCKET')): string {
  return `s3://${bucket}/${prefix}`;
}

/** The upload for one artefact, its text redacted. */
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

/** Store one artefact. Idempotent: a retry overwrites the same key, which versioning records. */
export async function putArtefact(prefix: string, path: string, body: string, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand(artefactObject(requireEnv('ARTEFACT_BUCKET'), prefix, path, body, contentType)));
}

export async function putJsonArtefact(prefix: string, path: string, value: unknown): Promise<void> {
  await putArtefact(prefix, path, `${JSON.stringify(value, null, 2)}\n`, 'application/json');
}

/** `test/result.json`, from the test workflow's callback output. */
export function testResultArtefact(result: { sha?: unknown; runUrl?: unknown; outcome?: unknown }): {
  sha?: string;
  runId?: number;
  runUrl?: string;
  conclusion?: string;
} {
  const runUrl = typeof result.runUrl === 'string' ? result.runUrl : undefined;
  const runId = runUrl ? /\/actions\/runs\/([0-9]+)/.exec(runUrl)?.[1] : undefined;
  return {
    ...(typeof result.sha === 'string' ? { sha: result.sha } : {}),
    ...(runId ? { runId: Number(runId) } : {}),
    ...(runUrl ? { runUrl } : {}),
    ...(typeof result.outcome === 'string' ? { conclusion: result.outcome } : {}),
  };
}
