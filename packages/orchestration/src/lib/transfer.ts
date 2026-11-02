/**
 * The transfer bucket (#262): how a file too large for a session command
 * reaches a session. A stage writes the file under the work item's key,
 * presigns a GET that expires in five minutes, and passes the URL to the
 * session's command; the session downloads it with curl. Nothing else reads
 * the bucket, and a lifecycle rule expires every object after a day. The
 * stage also deletes its object once the session has it, so it rarely lives
 * that long.
 *
 * It is not the artefact store, which is write-once, delete-denied and read
 * by no session. Keys follow the same correlation convention:
 * `<workItemId>/<attempt>/<stage>/<file>`.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { requireEnv } from './env.ts';

/** How long a presigned URL is valid: long enough for one session command to start and download. */
export const PRESIGNED_URL_SECONDS = 300;

const STAGE = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The key of a stage's transfer file, under the run's artefact prefix (`<workItemId>/<attempt>/`). */
export function transferKey(artefactPrefix: string, stage: string, file: string): string {
  if (!/^[0-9a-f-]{36}\/\d+\/$/.test(artefactPrefix)) throw new Error(`artefact prefix "${artefactPrefix}" is not <workItemId>/<attempt>/`);
  if (!STAGE.test(stage)) throw new Error(`transfer stage "${stage}" is not a plain path`);
  if (!FILE.test(file)) throw new Error(`transfer file "${file}" is not a plain name`);
  return `${artefactPrefix}${stage}/${file}`;
}

/** What moving a file through the bucket takes; the defaults are S3, replaced in tests. */
export interface Transfer {
  /** Upload a file from disk, streamed, in parts when it is large. */
  upload(key: string, filePath: string): Promise<void>;
  /** A GET URL for the key, signed with this function's credentials. */
  presign(key: string): Promise<string>;
  /** Delete the key; a missing key is not an error. */
  remove(key: string): Promise<void>;
}

let client: S3Client | undefined;
const s3 = (): S3Client => (client ??= new S3Client({}));
const bucket = (): string => requireEnv('TRANSFER_BUCKET');

export const s3Transfer: Transfer = {
  async upload(key, filePath) {
    const { size } = await stat(filePath);
    await new Upload({
      client: s3(),
      params: { Bucket: bucket(), Key: key, Body: createReadStream(filePath), ContentLength: size, ContentType: 'application/octet-stream' },
      // 16 MB parts, four at a time: a 100 MB bundle is seven parts.
      partSize: 16 * 1024 * 1024,
      queueSize: 4,
      leavePartsOnError: false,
    }).done();
  },
  presign(key) {
    return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn: PRESIGNED_URL_SECONDS });
  },
  async remove(key) {
    await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
  },
};
