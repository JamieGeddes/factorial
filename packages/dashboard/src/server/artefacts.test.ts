import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NoSuchKey } from '@aws-sdk/client-s3';

import { stubClient, ID, ID2 } from '../../test/stubs.ts';
import { createArtefacts, itemKey } from './artefacts.ts';

test('a key stays under its item: no .., no other item, no odd characters', () => {
  assert.equal(itemKey(ID, '1/build/usage.json'), `${ID}/1/build/usage.json`);
  for (const path of ['../x', `1/../../${ID2}/1/x`, '1//x', './x', '1/x/', '', 'a\\b', 'a\u0000b']) assert.equal(itemKey(ID, path), undefined, path);
  assert.equal(itemKey('not-an-id', '1/x'), undefined);
});

const body = (text: string) => ({
  transformToByteArray: async () => new TextEncoder().encode(text),
  transformToWebStream: () => new Response(text).body,
});

test('a finished item’s object is read once and kept; a running item’s is streamed each time', async () => {
  const s3 = stubClient({ GetObjectCommand: () => ({ Body: body('{"a":1}'), ContentType: 'application/json', ContentLength: 7 }) });
  const artefacts = createArtefacts(s3, async () => 'bucket');
  const first = await artefacts.get(`${ID}/1/x.json`, true);
  await artefacts.get(`${ID}/1/x.json`, true);
  assert.ok(first?.body instanceof Uint8Array);
  assert.equal(s3.calls.length, 1);
  const running = await artefacts.get(`${ID}/1/y.json`, false);
  assert.ok(running?.body instanceof ReadableStream);
});

test('a missing object or chunk is undefined, and a missing chunk is asked for again later', async () => {
  let exists = false;
  const s3 = stubClient({
    GetObjectCommand: () => {
      if (!exists) throw new NoSuchKey({ message: 'no', $metadata: {} });
      return { Body: body('line') };
    },
  });
  const artefacts = createArtefacts(s3, async () => 'bucket');
  assert.equal(await artefacts.chunk('k'), undefined);
  exists = true;
  assert.equal(await artefacts.chunk('k'), 'line');
  assert.equal(await artefacts.chunk('k'), 'line');
  assert.equal(s3.calls.length, 2);
});

test('the listing covers every page of the item’s prefix', async () => {
  const s3 = stubClient({
    ListObjectsV2Command: (input) =>
      input.ContinuationToken
        ? { Contents: [{ Key: `${ID}/2/b`, Size: 2 }] }
        : { Contents: [{ Key: `${ID}/1/a`, Size: 1, LastModified: new Date('2026-11-01T00:00:00Z') }], IsTruncated: true, NextContinuationToken: 't' },
  });
  const list = await createArtefacts(s3, async () => 'bucket').list(ID);
  assert.deepEqual(list, [
    { key: `${ID}/1/a`, size: 1, lastModified: '2026-11-01T00:00:00.000Z' },
    { key: `${ID}/2/b`, size: 2 },
  ]);
  assert.equal(s3.calls[0]?.input.Prefix, `${ID}/`);
});
