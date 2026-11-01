import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SnapshotIndex, SnapshotItem } from './format.ts';
import { answer, hashOf, pathOf, routeOf } from './routes.ts';

const ID = '0a205db0-cb0e-11f1-994d-773dd71bc5d5';

test('hash names: every app path has one, and it reads back to the same path', () => {
  const paths = ['/', '/work-items', `/work-items/${ID}`, '/runs', `/runs/${ID}/build/2`, '/metrics', '/health'];
  for (const path of paths) {
    const hash = hashOf(path);
    assert.match(hash, /^[a-z0-9-]+$/, `${path} → ${hash}`);
    assert.equal(pathOf(`#${hash}`), path);
  }
  assert.equal(hashOf('/work-items?filter=running'), 'work-items');
  assert.equal(hashOf('/metrics?range=7'), 'metrics');
  assert.equal(hashOf('/somewhere/else'), 'overview');
  assert.equal(pathOf(''), '/');
  assert.deepEqual(routeOf(pathOf(`#run-${ID}-review-1`)), { kind: 'run', id: ID, stage: 'review', round: 1 });
  assert.deepEqual(routeOf(pathOf('#nothing-here')), { kind: 'missing', path: '/nothing-here' });
});

const summary = (id: string, title: string, running: boolean) =>
  ({ id, title, running, waiting: false, attempt: 1, source: { type: 'github-issue', ref: '#1', label: 'Issue' }, status: { text: running ? 'building' : 'pr-opened', tone: 'ok' } }) as unknown as SnapshotIndex['workItems']['items'][number];

const index = {
  format: 1,
  capturedAt: '2026-10-31T22:00:00.000Z',
  capturedAtMs: Date.parse('2026-10-31T22:00:00.000Z'),
  redacted: [],
  status: { runtimes: [], region: 'eu-west-1', errors: [] },
  overview: {},
  running: { items: [] },
  health: {},
  metrics: { '30|': { range: 30 }, '7|o/r': { range: 7, repository: 'o/r' } },
  workItems: { items: [summary(ID, 'Alpha', true), summary(ID.replace('0a', '1b'), 'Beta', false)], total: 2, sources: [], counts: { running: 1, waiting: 0 } },
  runs: [],
  runCount: 0,
  items: { [ID]: { file: `data/items/${ID}.json` } },
} as unknown as SnapshotIndex;

const item: SnapshotItem = {
  detail: { row: { workItemId: ID } } as unknown as SnapshotItem['detail'],
  runs: { 'build/1': { id: ID, stage: 'build', round: 1 } as unknown as SnapshotItem['runs'][string] },
  artefacts: {
    '1/plan/plan.md': { kind: 'text', text: '# Plan', contentType: 'text/plain; charset=utf-8' },
    '1/build/transcript.jsonl': { kind: 'file', file: `data/files/${ID}/1/build/transcript.jsonl`, size: 10, contentType: 'application/x-ndjson; charset=utf-8' },
    '1/build/bundle.git': { kind: 'binary', size: 99 },
  },
};
const read = async (id: string) => (id === ID ? item : undefined);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = async (url: string, method = 'GET'): Promise<{ file?: string; status?: number; body?: string; json?: any }> => {
  const a = await answer(new URL(url, 'http://host/some/prefix/index.html'), method, index, read);
  assert.ok(a);
  return 'file' in a ? a : { ...a, json: a.contentType.startsWith('application/json') ? JSON.parse(a.body) : undefined };
};

test('data routes: the index answers the views, items answer by file, filters run in the page', async () => {
  assert.equal(await answer(new URL('http://host/some/prefix/data/x.json'), 'GET', index, read), undefined);
  assert.deepEqual((await body('/api/status')).json, index.status);
  assert.equal((await body('/api/metrics?range=7&repository=o%2Fr')).json.repository, 'o/r');
  assert.equal((await body('/api/metrics')).json.range, 30);
  assert.equal((await body('/api/metrics?range=90')).status, 404);
  const all = (await body('/api/work-items?limit=500')).json;
  assert.equal(all.total, 2);
  assert.equal((await body('/api/work-items?filter=running')).json.total, 1);
  assert.equal((await body('/api/work-items?q=beta')).json.items[0].title, 'Beta');
  assert.equal((await body('/api/work-items?limit=1')).json.nextCursor, '1');
  assert.equal((await body(`/api/work-items/${ID}`)).json.row.workItemId, ID);
  assert.equal((await body(`/api/work-items/${ID.replace('0a', '1b')}`)).status, 404);
  assert.equal((await body(`/api/runs/${ID}/build/1`)).json.stage, 'build');
  assert.equal((await body(`/api/runs/${ID}/build/2`)).status, 404);
  assert.equal((await body(`/api/work-items/${ID}/artefacts/1/plan/plan.md`)).body, '# Plan');
  assert.deepEqual(await body(`/api/work-items/${ID}/artefacts/1/build/transcript.jsonl`), { file: `data/files/${ID}/1/build/transcript.jsonl` });
  assert.equal((await body(`/api/work-items/${ID}/artefacts/1/build/bundle.git`)).status, 404);
  assert.deepEqual((await body('/api/live/abc', 'POST')).json, { channels: [] });
  assert.equal((await body('/api/work-items', 'POST')).status, 405);
});
