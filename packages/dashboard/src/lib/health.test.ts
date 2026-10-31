import assert from 'node:assert/strict';
import { test } from 'node:test';

import { health, reasonKey, startLatency, type HealthInput } from './health.ts';
import type { LedgerRow } from './records.ts';

const NOW = Date.parse('2026-11-01T12:30:00Z');
const id = (n: number) => `0000000${n}-d53d-11f1-8851-ff488f20a8b2`;

const base = (over: Partial<HealthInput> = {}): HealthInput => ({
  now: NOW,
  rows: [],
  live: { published: 900, dropped: 0, runs: 3 },
  connection: 'connected',
  adapter: { value: { invocations: 40, errors: 0 } },
  deliveries: { value: { hours: [], reasons: [] } },
  bus: { value: { invocations: 120, failed: 0 } },
  busRate: { value: 2.1 },
  stateMachine: { value: { running: 3, failedToday: 0, liveVersion: '128' } },
  invoker: { value: 2 },
  runtimes: { value: [{ name: 'factorial_builder', role: 'builder', version: '47', status: 'READY' }] },
  models: { value: [{ model: 'global.anthropic.claude-sonnet-5-5', tpm: { peak: 3_660_000, limit: 6_000_000 } }] },
  retries: { value: [] },
  artefacts: { value: { bytes: 1.9e9, objects: 4120 } },
  ledger: { value: { throttled: 0 } },
  table: { value: { items: 1044 } },
  alarms: { value: [] },
  quotas: { value: [] },
  deploys: { value: [] },
  repository: { owner: 'JamieGeddes', name: 'factorial' },
  ...over,
});

const component = (h: ReturnType<typeof health>, name: string) => h.components.find((c) => c.name === name);

test('every component with what it reported, ok when nothing is wrong', () => {
  const h = health(base());
  assert.deepEqual(component(h, 'State machine factorial-work'), { name: 'State machine factorial-work', detail: '3 running, 0 failed today', figure: 'alias live → v128', status: 'ok' });
  assert.equal(component(h, 'Runtime factorial_builder')?.detail, 'live → v47, READY');
  assert.equal(component(h, 'Bedrock, Sonnet 5.5 global profile')?.figure, 'TPM peak 61% of quota');
  assert.equal(component(h, 'Artefact store')?.detail, '1.9 GB in 4,120 objects (daily)');
  assert.equal(component(h, 'Ledger factorial-work-items')?.figure, '1,044 rows');
  assert.equal(component(h, 'Live feed factorial-live')?.figure, '900 published, 0 dropped / 24h');
  assert.equal(component(h, 'Traces (Transaction Search)')?.status, 'off');
  assert.ok(h.components.filter((c) => c.name !== 'Traces (Transaction Search)').every((c) => c.status === 'ok'), JSON.stringify(h.components));
});

test('a warning for failures, retries and a source that could not be read, never a made-up figure', () => {
  const h = health(
    base({
      stateMachine: { value: { running: 0, failedToday: 2 } },
      retries: { value: [{ model: 'global.anthropic.claude-sonnet-5-5', n: 1 }, { n: 2 }] },
      invoker: { error: 'AccessDeniedException: not authorised to ecs:ListTasks' },
      connection: 'down',
    }),
  );
  assert.equal(component(h, 'State machine factorial-work')?.status, 'warn');
  assert.equal(component(h, 'Bedrock, Sonnet 5.5 global profile')?.detail, '1 retry in 15 min');
  assert.equal(component(h, 'Bedrock, other runs')?.status, 'warn');
  assert.deepEqual(component(h, 'Fargate invoker'), { name: 'Fargate invoker', detail: 'could not read ECS tasks', figure: 'AccessDeniedException: not authorised to ecs:ListTasks', status: 'warn' });
  assert.equal(component(h, 'Live feed factorial-live')?.status, 'warn');
});

test('webhook deliveries per hour, by outcome, with the ignored reasons folded', () => {
  const hour = (h: number) => Date.UTC(2026, 10, 1, h);
  const h = health(
    base({
      deliveries: {
        value: {
          hours: [
            { at: hour(12), outcome: 'ignored', n: 5 },
            { at: hour(12), outcome: 'work-item', n: 1 },
            { at: hour(9), outcome: 'rejected', n: 1 },
            { at: hour(9), outcome: 'failed', n: 1 },
            { at: Date.UTC(2026, 9, 30, 9), outcome: 'ignored', n: 9 },
          ],
          reasons: [
            { reason: 'ignored label "bug"', n: 3 },
            { reason: 'ignored label "docs"', n: 2 },
            { reason: 'pull request #12 is closed', n: 1 },
          ],
        },
      },
    }),
  );
  assert.equal(h.webhooks.labels.length, 24);
  assert.equal(h.webhooks.workItems[23], 1);
  assert.equal(h.webhooks.ignored[23], 5);
  assert.equal(h.webhooks.other[20], 2);
  assert.deepEqual(h.webhooks.totals, { delivered: 8, workItems: 1, closed: 0, ignored: 5, rejected: 1, failed: 1, unhandled: 0 });
  assert.deepEqual(h.webhooks.reasons, [
    { reason: 'ignored label "…"', n: 5 },
    { reason: 'pull request #n is closed', n: 1 },
  ]);
  assert.equal(h.webhooks.note, undefined);
  assert.match(health(base()).webhooks.note ?? '', /40 invocations in 24 h but no delivery lines/);
});

test('deploy rows: links built from the repository, stacks and promotions as recorded, attempts named', () => {
  const sha = 'aea138a0123456789abcdef0123456789abcdef0';
  const h = health(
    base({
      deploys: {
        value: [
          { id: 41237728984, attempt: 2, sha, title: 'Merge pull request #236\n\nbody', at: '2026-11-01T12:11:27Z', status: 'deployed', stacks: ['agent', 'orchestration'], promoted: [{ runtime: 'factorial_builder', version: '47' }] },
          { id: 41206788423, attempt: 1, sha, title: 'Old', at: '2026-10-31T13:42:35Z', status: 'failed' },
          { id: 41206788424, attempt: 1, sha, title: 'Docs', at: '2026-10-31T13:42:35Z', status: 'skipped', stacks: [] },
        ],
      },
    }),
  );
  const [first, second, third] = h.deploys.rows;
  assert.equal(first?.shaUrl, `https://github.com/JamieGeddes/factorial/commit/${sha}`);
  assert.equal(first?.runUrl, 'https://github.com/JamieGeddes/factorial/actions/runs/41237728984/attempts/2');
  assert.equal(first?.title, 'Merge pull request #236 body');
  assert.equal(first?.stacks, 'agent, orchestration');
  assert.equal(first?.promoted, 'builder v47');
  assert.equal(second?.stacks, '–');
  assert.equal(second?.promoted, '–');
  assert.equal(third?.stacks, 'none changed');
});

test("the invoker's start latency: Prepare's end to Build's start", () => {
  const rows: LedgerRow[] = [10, 40, 70].map((gap, n) => ({
    workItemId: id(n),
    stages: { Prepare: { startedAt: '2026-11-01T10:00:00Z', endedAt: '2026-11-01T10:01:00Z' }, Build: { startedAt: new Date(Date.parse('2026-11-01T10:01:00Z') + gap * 1000).toISOString() } },
  }));
  assert.equal(startLatency(rows), 40);
  assert.equal(startLatency([]), undefined);
});

test('reasons are text, folded', () => {
  assert.equal(reasonKey('label applied by untrusted user "x‮"'), 'label applied by untrusted user "…"');
});
