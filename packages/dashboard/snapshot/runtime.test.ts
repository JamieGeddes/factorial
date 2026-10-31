import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SnapshotIndex, SnapshotItem } from './format.ts';
import { install, type Snapshot } from './runtime.ts';

const ID = '0a205db0-cb0e-11f1-994d-773dd71bc5d5';
const BASE = 'file:///Users/someone/factorial-command-centre-2026-10-31.html';

test('install: data routes are answered from the snapshot, files through its own reader, the rest through the page', async () => {
  const reads: string[] = [];
  const page: string[] = [];
  const item: SnapshotItem = {
    detail: { row: { workItemId: ID } } as unknown as SnapshotItem['detail'],
    runs: {},
    artefacts: { '1/build/transcript.jsonl': { kind: 'file', file: `data/files/${ID}/1/build/transcript.jsonl`, size: 3, contentType: 'application/x-ndjson; charset=utf-8' } },
  };
  const snapshot: Snapshot = {
    index: { format: 1, status: { runtimes: [], region: 'eu-west-1', errors: [] }, items: { [ID]: { file: `data/items/${ID}.json` } } } as unknown as SnapshotIndex,
    url: (file) => new URL(file, BASE),
    read: async (input) => {
      reads.push(String(input instanceof URL ? input.href : input));
      return new Response('{}\n');
    },
    item: async (id) => (id === ID ? item : undefined),
  };
  const target = { fetch: (async (input: RequestInfo | URL) => {
    page.push(String(input instanceof URL ? input.href : input));
    return new Response('page');
  }) as typeof fetch, EventSource: undefined as unknown, history: { pushState: 1 as unknown, replaceState: 1 as unknown } };
  install(snapshot, target);

  assert.equal((await (await target.fetch('/api/status')).json()).region, 'eu-west-1');
  assert.equal(await (await target.fetch(`/api/work-items/${ID}/artefacts/1/build/transcript.jsonl`, { cache: 'no-store' })).text(), '{}\n');
  assert.deepEqual(reads, [`file:///Users/someone/data/files/${ID}/1/build/transcript.jsonl`]);
  assert.equal(await (await target.fetch('https://example.com/elsewhere')).text(), 'page');
  assert.deepEqual(page, ['https://example.com/elsewhere']);
  assert.equal((await target.fetch(`/api/work-items/${ID}/artefacts/1/missing.md`)).status, 404);
  assert.equal(typeof target.history.pushState, 'function');
  assert.equal(typeof target.EventSource, 'function');
});
