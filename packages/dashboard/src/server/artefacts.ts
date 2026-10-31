import 'server-only';

import { GetObjectCommand, ListObjectsV2Command, NoSuchKey } from '@aws-sdk/client-s3';

import { ByteCache } from './cache.ts';
import type { Sender } from './aws.ts';

/**
 * The artefact store, read only. A finished item's records never change, so
 * what has been read of one is kept in memory for the life of the process; a
 * running item's objects are read afresh, except catch-up chunks, each
 * written once.
 */
export interface ArtefactObject {
  key: string;
  size: number;
  lastModified?: string;
}

export interface ArtefactContent {
  bytes: Uint8Array;
  contentType: string;
}

/** An object as the artefact route sends it: bytes once kept, a stream otherwise. */
export interface ArtefactBody {
  body: Uint8Array | ReadableStream<Uint8Array>;
  contentType: string;
  size?: number;
}

export interface Artefacts {
  /** Every object under `<workItemId>/`, every attempt. */
  list(workItemId: string): Promise<ArtefactObject[]>;
  /** One object, or undefined when it does not exist. A finished item's is read whole and kept; a running item's is streamed. */
  get(key: string, finished: boolean): Promise<ArtefactBody | undefined>;
  /** A catch-up chunk's text, or undefined until it exists. */
  chunk(key: string): Promise<string | undefined>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isWorkItemId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * The full key for a path under an item's prefix, or undefined when the path
 * could leave it: no `..` or `.` segment, no empty segment, no backslash, no
 * control character, and only the item's own id at the front.
 */
export function itemKey(workItemId: string, path: string): string | undefined {
  if (!isWorkItemId(workItemId)) return undefined;
  if (path.length === 0 || path.length > 900) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return undefined;
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return undefined;
  return `${workItemId}/${path}`;
}

export function createArtefacts(s3: Sender, bucket: () => Promise<string>, maxBytes = 256 * 1024 * 1024): Artefacts {
  const cache = new ByteCache(maxBytes);
  type S3Object = {
    Body?: { transformToByteArray(): Promise<Uint8Array>; transformToWebStream(): ReadableStream<Uint8Array> };
    ContentType?: string;
    ContentLength?: number;
  };
  const fetchObject = async (key: string): Promise<S3Object | undefined> => {
    try {
      return (await s3.send(new GetObjectCommand({ Bucket: await bucket(), Key: key }))) as S3Object;
    } catch (error) {
      if (error instanceof NoSuchKey || (error as { name?: string }).name === 'NoSuchKey') return undefined;
      throw error;
    }
  };
  const read = async (key: string): Promise<ArtefactContent | undefined> => {
    const object = await fetchObject(key);
    if (!object) return undefined;
    const bytes = (await object.Body?.transformToByteArray()) ?? new Uint8Array();
    return { bytes, contentType: object.ContentType ?? 'application/octet-stream' };
  };
  return {
    async list(workItemId) {
      if (!isWorkItemId(workItemId)) return [];
      const objects: ArtefactObject[] = [];
      let token: string | undefined;
      do {
        const page = (await s3.send(
          new ListObjectsV2Command({ Bucket: await bucket(), Prefix: `${workItemId}/`, ...(token ? { ContinuationToken: token } : {}) }),
        )) as { Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date }>; NextContinuationToken?: string; IsTruncated?: boolean };
        for (const o of page.Contents ?? []) {
          if (!o.Key) continue;
          objects.push({ key: o.Key, size: o.Size ?? 0, ...(o.LastModified ? { lastModified: o.LastModified.toISOString() } : {}) });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return objects;
    },
    async get(key, finished) {
      const hit = cache.get(key);
      if (hit) return { body: hit.bytes, contentType: hit.contentType, size: hit.bytes.byteLength };
      if (finished) {
        const content = await read(key);
        if (!content) return undefined;
        cache.set(key, content.bytes, content.contentType);
        return { body: content.bytes, contentType: content.contentType, size: content.bytes.byteLength };
      }
      const object = await fetchObject(key);
      if (!object) return undefined;
      return {
        body: object.Body?.transformToWebStream() ?? new Uint8Array(),
        contentType: object.ContentType ?? 'application/octet-stream',
        ...(object.ContentLength !== undefined ? { size: object.ContentLength } : {}),
      };
    },
    async chunk(key) {
      const hit = cache.get(key);
      if (hit) return new TextDecoder().decode(hit.bytes);
      const content = await read(key);
      if (!content) return undefined;
      cache.set(key, content.bytes, content.contentType);
      return new TextDecoder().decode(content.bytes);
    },
  };
}
