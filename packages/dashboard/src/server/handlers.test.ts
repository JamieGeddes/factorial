import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stubServices } from '../../test/services.ts';
import { ID, ID2 } from '../../test/stubs.ts';
import type { LedgerRow } from '../lib/records.ts';
import { getArtefact, getOverview, getRun, getRunning, getStatus, getWorkItem, getWorkItems, postLiveChannels, safeContentType } from './handlers.ts';

const item = (id: string, fields: Partial<LedgerRow>): LedgerRow => ({
  workItemId: id,
  createdAt: '2026-11-01T10:00:00Z',
  attempt: 1,
  artefactPrefix: `${id}/1/`,
  workItem: { title: `item ${id.slice(0, 4)}`, requestedBy: 'jamie', source: { type: 'github-issue', id: '7' }, repository: { owner: 'JamieGeddes', name: 'factorial' } },
  ...fields,
});

const rows = [
  item(ID, { result: 'pr-opened', threadKey: 'k', prNumber: 3 }),
  item(ID2, { createdAt: '2026-11-01T09:00:00Z', stages: { Build: { startedAt: '2026-11-01T09:01:00Z' } } }),
];

const read = async (response: Response) => ({ status: response.status, body: (await response.json()) as Record<string, unknown> });

test('/api/work-items: running first, filtered, with sources and counts', async () => {
  const services = stubServices({ rows, threads: [{ threadKey: 'k', outcome: { state: 'merged', at: 'a', by: 'b' } }] });
  const all = await read(await getWorkItems(new Request('http://h/api/work-items'), services));
  const items = all.body.items as Array<{ id: string; status: { label: string } }>;
  assert.deepEqual(items.map((i) => i.id), [ID2, ID]);
  assert.equal(items[1]?.status.label, 'merged');
  assert.deepEqual(all.body.counts, { running: 1, waiting: 0 });
  assert.deepEqual(all.body.sources, [{ type: 'github-issue', label: 'GitHub issue' }]);
  const running = await read(await getWorkItems(new Request('http://h/api/work-items?filter=running'), services));
  assert.deepEqual((running.body.items as Array<{ id: string }>).map((i) => i.id), [ID2]);
  const page = await read(await getWorkItems(new Request('http://h/api/work-items?limit=1'), services));
  assert.equal(page.body.nextCursor, '1');
});

test('/api/work-items/{id}: the row, its thread and its artefacts; 400 and 404 otherwise', async () => {
  const services = stubServices({ rows, threads: [{ threadKey: 'k', prNumber: 3 }], objects: { [`${ID}/1/report.json`]: '{}' } });
  const found = await read(await getWorkItem(services, ID));
  assert.equal(found.status, 200);
  assert.equal((found.body.thread as { prNumber: number }).prNumber, 3);
  assert.deepEqual((found.body.artefacts as Array<{ key: string }>).map((a) => a.key), [`${ID}/1/report.json`]);
  assert.equal((await getWorkItem(services, 'nope')).status, 400);
  assert.equal((await getWorkItem(services, '00000000-0000-0000-0000-000000000000')).status, 404);
});

test('/api/work-items/{id}/artefacts/{key}: only under the item, never as HTML', async () => {
  const services = stubServices({ rows, objects: { [`${ID}/1/x.html`]: '<script>alert(1)</script>', [`${ID2}/1/secret.json`]: '{}' } });
  const ok = await getArtefact(services, ID, ['1', 'x.html']);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.match(ok.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(await ok.text(), '<script>alert(1)</script>');
  assert.equal((await getArtefact(services, ID, ['..', ID2, '1', 'secret.json'])).status, 400);
  assert.equal((await getArtefact(services, ID, ['%2E%2E', ID2, '1', 'secret.json'])).status, 400);
  assert.equal((await getArtefact(services, ID, ['1', 'missing.json'])).status, 404);
});

test('content types: what the artefact is, never something a browser runs', () => {
  assert.equal(safeContentType('a/usage.json', 'binary/octet-stream'), 'application/json; charset=utf-8');
  assert.equal(safeContentType('a/transcript.jsonl', ''), 'application/x-ndjson; charset=utf-8');
  assert.equal(safeContentType('a/plan.md', 'text/markdown'), 'text/plain; charset=utf-8');
  assert.equal(safeContentType('a/page', 'text/html'), 'text/plain; charset=utf-8');
  assert.equal(safeContentType('a/image.svg', 'image/svg+xml'), 'application/octet-stream');
});

test('/api/running: items with no result yet', async () => {
  const body = (await read(await getRunning(stubServices({ rows })))).body;
  assert.deepEqual((body.items as Array<{ summary: { id: string } }>).map((i) => i.summary.id), [ID2]);
});

test('/api/status: the live version, the Runtimes, the bus rate and the alarms', async () => {
  const body = (await read(await getStatus(stubServices({ rows })))).body;
  assert.deepEqual(body.version, { sha: '5e26e4e57cabd29f1703567b4a81d19b96a87ac8', url: 'https://github.com/JamieGeddes/factorial/commit/5e26e4e57cabd29f1703567b4a81d19b96a87ac8' });
  assert.deepEqual(body.runtimes, [
    { name: 'factorial_builder', role: 'builder', version: '45', status: 'READY' },
    { name: 'factorial_reviewer', role: 'reviewer', version: '28', status: 'READY' },
  ]);
  assert.equal(body.busRate, 2.1);
  assert.deepEqual(body.alarms, { total: 0, firing: [] });
  assert.deepEqual(body.errors, []);
});

test('a failed source is reported and the rest still shown', async () => {
  const services = stubServices({ rows });
  services.clients.cw.send = async () => {
    throw new Error('AccessDenied');
  };
  const body = (await read(await getStatus(services))).body;
  assert.equal(body.busRate, undefined);
  assert.equal((body.runtimes as unknown[]).length, 2);
  assert.ok((body.errors as string[]).some((e) => e.includes('AccessDenied')));
});

test('a stream’s channels change by JSON only, for a stream that exists', async () => {
  const services = stubServices({ rows });
  const sent: unknown[] = [];
  const stream = services.live.open({ send: (m) => sent.push(m) });
  const post = (body: string, type = 'application/json', id = stream.id) => postLiveChannels(new Request('http://h', { method: 'POST', headers: { 'content-type': type }, body }), services, id);
  assert.equal((await post('{"channels":[]}', 'text/plain')).status, 415);
  assert.equal((await post('{"channels":[]}', 'application/json', 'nope')).status, 404);
  assert.equal((await post('{"channels":"x"}')).status, 400);
  const ok = await read(await post(JSON.stringify({ channels: ['/factorial/work-items', '/factorial/other', `/factorial/runs/${ID}/build/1`] })));
  assert.deepEqual(ok.body.channels, ['/factorial/work-items', `/factorial/runs/${ID}/build/1`]);
  stream.close();
});

test('/api/overview: tiles, pucks and sessions from the ledger', async () => {
  const services = stubServices({ rows, threads: [{ threadKey: 'k', outcome: { state: 'merged', at: 'a', by: 'b' } }] });
  const { status, body } = await read(await getOverview(services));
  assert.equal(status, 200);
  assert.equal((body.pucks as Array<{ id: string; stage: string }>).map((p) => `${p.id}:${p.stage}`).join(), `${ID2}:Build`);
  assert.equal((body.tiles as Array<{ label: string }>).length, 6);
  assert.deepEqual(body.notices, []);
});

test('/api/runs/{id}/{stage}/{round}: the stored plan, else the builder\'s write in the chunks; limits from usage.json; 400 and 404', async () => {
  const plan = JSON.stringify({ steps: [{ id: 'stored', files: [] }] });
  const written = JSON.stringify({ steps: [{ id: 'written', files: ['x.ts'] }] });
  const chunk = `{"at":"a","seq":4,"type":"tool.call","tool":"write","input":{"path":"/workspace/plan.json","content":${JSON.stringify(written)}}}\n`;
  const done = item(ID, { result: 'pr-opened', stages: { Build: { startedAt: 'a', endedAt: 'b', run: { usageKey: `${ID}/1/build/usage.json` } } } });
  const running = item(ID2, { stages: { Build: { startedAt: '2026-11-01T09:01:00Z' } } });
  const services = stubServices({
    rows: [done, running],
    objects: { [`${ID}/1/plan/plan.json`]: plan, [`${ID}/1/build/usage.json`]: '{"maxTurns":150,"maxBudgetUsd":5}', [`${ID2}/1/build/live/0001.jsonl`]: chunk },
  });
  const finished = await read(await getRun(services, ID, 'build', '1'));
  assert.equal(finished.status, 200);
  assert.deepEqual(finished.body.plan, { steps: [{ id: 'stored', files: [] }], source: 'plan/plan.json, as Collect stored it' });
  assert.deepEqual(finished.body.limits, { maxTurns: 150, maxBudgetUsd: 5 });
  assert.equal(finished.body.transcript, `/api/work-items/${ID}/artefacts/1/build/transcript.jsonl`);
  const live = await read(await getRun(services, ID2, 'build', '1'));
  assert.deepEqual(live.body.plan, { steps: [{ id: 'written', files: ['x.ts'] }], source: "the builder's write of plan.json, event 4" });
  assert.equal(live.body.transcript, undefined);
  assert.equal((await read(await getRun(services, ID2, 'review', '1'))).body.plan, undefined);
  assert.equal((await getRun(services, 'nope', 'build', '1')).status, 400);
  assert.equal((await getRun(services, ID, 'Build', '1')).status, 404);
  assert.equal((await getRun(services, '00000000-0000-0000-0000-000000000000', 'build', '1')).status, 404);
});
