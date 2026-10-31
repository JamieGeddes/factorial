import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { health } from '../lib/health.ts';
import { metrics } from '../lib/metrics.ts';
import { HealthView } from './health/HealthView.tsx';
import { MetricsView } from './metrics/MetricsView.tsx';

const router = { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} };
const render = (node: ReactNode) => renderToStaticMarkup(<AppRouterContext.Provider value={router as never}>{node}</AppRouterContext.Provider>);

const ID = '7f93ccb0-d53d-11f1-8851-ff488f20a8b2';
const HOSTILE = '<img src=x onerror=alert(1)>';
const NOW = Date.parse('2026-11-01T12:00:00Z');

test('the Metrics view renders on the server, with the range chosen and markup as text (#59)', () => {
  const row = {
    workItemId: ID,
    createdAt: '2026-11-01T09:00:00Z',
    result: 'pr-opened',
    endedAt: '2026-11-01T11:00:00Z',
    workItem: { title: HOSTILE, source: { type: 'github-issue', id: '1' }, repository: { owner: 'JamieGeddes', name: 'factorial' } },
    stages: { Build: { startedAt: '2026-11-01T09:01:00Z', endedAt: '2026-11-01T10:00:00Z', run: { role: 'builder', runtimeVersion: '47', harness: { name: HOSTILE }, costUsd: 2, durationSeconds: 3540 } } },
  };
  const data = metrics({ rows: [row], threads: new Map(), records: new Map(), now: NOW, range: 7, resultSince: '2026-10-01T00:00:00Z' });
  const html = render(<MetricsView initial={data} />);
  assert.match(html, /<h1>Metrics and cost<\/h1>/);
  assert.match(html, /aria-pressed="true"[^>]*>7 days</);
  assert.match(html, /Cost per pull request/);
  assert.match(html, /Runtime versions compared/);
  assert.match(html, />v47</);
  assert.match(html, /No timed model calls in the range/);
  assert.ok(!html.includes('<img'));
});

test('the Health view renders on the server: alarms not set up name #16, and markup stays text (#59)', () => {
  const data = health({
    now: NOW,
    rows: [],
    live: { published: 0, dropped: 0, runs: 0 },
    connection: 'connected',
    adapter: { value: { invocations: 2, errors: 0 } },
    deliveries: { value: { hours: [], reasons: [{ reason: `ignored label "${HOSTILE}"`, n: 1 }] } },
    bus: { value: { invocations: 1, failed: 0 } },
    busRate: { value: 0.1 },
    stateMachine: { value: { running: 0, failedToday: 0, liveVersion: '128' } },
    invoker: { value: 0 },
    runtimes: { value: [] },
    models: { value: [] },
    retries: { value: [] },
    artefacts: { value: {} },
    ledger: { value: { throttled: 0 } },
    table: { value: {} },
    alarms: { value: [] },
    quotas: { value: [{ name: 'Fargate vCPU', used: 8, limit: 384, display: '8 / 384' }] },
    deploys: { value: [{ id: 1, attempt: 1, sha: 'e9c3377a0123456789abcdef0123456789abcdef', title: HOSTILE, at: '2026-11-01T11:00:00Z', status: 'failed' }] },
    repository: { owner: 'JamieGeddes', name: 'factorial' },
  });
  const html = render(<HealthView initial={data} />);
  assert.match(html, /<h1>Health<\/h1>/);
  assert.match(html, /Alarms<\/b>: not set up yet, #16 adds it/);
  assert.match(html, /href="https:\/\/github.com\/JamieGeddes\/factorial\/commit\/e9c3377a0123456789abcdef0123456789abcdef"/);
  assert.match(html, /class="pill failed">failed</);
  assert.match(html, /role="meter"/);
  assert.match(html, /aria-label="off"/);
  assert.ok(!html.includes('<img'));
});
