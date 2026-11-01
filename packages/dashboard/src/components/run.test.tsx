import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { VirtualList } from '../client/virtual-list.tsx';
import { overview } from '../lib/overview.ts';
import type { LedgerRow } from '../lib/records.ts';
import { runDetail } from '../lib/run-view.ts';
import { describe, type RunEvent } from '../lib/transcript.ts';
import { runsEmptyMessage } from '../lib/runs-list.ts';
import { summarise } from '../lib/work-items.ts';
import { sortRows } from './Table.tsx';
import { StageGraph } from './overview/StageGraph.tsx';
import { OverviewView } from './overview/OverviewView.tsx';
import { RunsTable, RUN_COLUMNS } from './run/RunsTable.tsx';
import { RunsView } from './run/RunsView.tsx';
import { RunView } from './run/RunView.tsx';
import { TranscriptEvent } from './run/TranscriptEvent.tsx';

const router = { push() {}, replace() {}, refresh() {}, prefetch() {}, back() {}, forward() {} };
const render = (node: ReactNode) => renderToStaticMarkup(<AppRouterContext.Provider value={router as never}>{node}</AppRouterContext.Provider>);

const ID = '7f93ccb0-d53d-11f1-8851-ff488f20a8b2';
const HOSTILE = '<img src=x onerror=alert(1)>';
const event = (e: Record<string, unknown>): RunEvent => ({ seq: 7, at: '2026-11-01T10:00:00Z', event: e });
const line = (entry: RunEvent) => render(<TranscriptEvent entry={entry} line={describe(entry)} open onToggle={() => {}} />);

test('a transcript line holding <img src=x onerror=alert(1)> shows as text', () => {
  for (const e of [
    { type: 'text', text: HOSTILE },
    { type: 'reasoning', text: HOSTILE },
    { type: 'tool.call', tool: HOSTILE, input: { command: HOSTILE } },
    { type: 'tool.result', content: `${HOSTILE}\nmore` },
    { type: 'model.retry', attempt: 1, error: HOSTILE },
    { type: 'harness', name: HOSTILE },
    { type: HOSTILE },
  ]) {
    const html = line(event(e));
    assert.ok(!html.includes('<img'), html);
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), html);
  }
});

test("a subagent's events are marked as its own, and a cut field says so", () => {
  const html = line({ ...event({ type: 'text', text: 'x', agentId: 'a1' }), truncated: true, bytes: 40_000 });
  assert.match(html, /class="ev text in-agent"/);
  assert.match(html, /<span class="cut">truncated, 39.1 KB in full<\/span>/);
  assert.match(html, /<span class="seq num">7<\/span>/);
});

test('the transcript list renders only the rows in view, however many there are', () => {
  const keys = Array.from({ length: 50_000 }, (_, i) => i + 1);
  const html = render(<VirtualList keys={keys} label="Transcript" follow={false} onScrollAway={() => {}} render={(i) => <span className="row">{keys[i]}</span>} />);
  const rows = html.match(/class="row"/g)?.length ?? 0;
  assert.ok(rows > 10 && rows < 200, `${rows} rows rendered`);
  assert.match(html, /style="height:1300000px"/);
});

test('the stage graph draws every stage and a puck per item, styled by kind', () => {
  const html = render(
    <StageGraph
      stages={[{ stage: 'Build', p50: 1460, runs: 3 }]}
      pucks={[
        { id: ID, title: HOSTILE, ref: '#1', stage: 'Build', kind: 'builder', round: 2, href: `/runs/${ID}/build/2` },
        { id: ID.replace('7', '8'), title: 't', ref: '#2', stage: 'Test', kind: 'waiting', href: '/work-items/x' },
      ]}
    />,
  );
  assert.equal(html.match(/class="stage[ "]/g)?.length, 9);
  assert.match(html, /Prepare review/);
  assert.match(html, /p50 24m 20s/);
  assert.match(html, new RegExp(`class="puck" title="7f93ccb0 #1: &lt;img src=x onerror=alert\\(1\\)&gt; \\(builder session, round 2\\)"[^>]*href="/runs/${ID}/build/2"|href="/runs/${ID}/build/2"[^>]*class="puck"`));
  assert.match(html, /class="puck waiting"/);
  assert.match(html, />r2</);
  assert.ok(!html.includes('<img'));
});

test('the Overview and the run view render on the server from their data', () => {
  const row = {
    workItemId: ID,
    createdAt: '2026-11-01T11:00:00Z',
    workItem: { title: HOSTILE, source: { type: 'github-issue', id: '1' }, repository: { owner: 'JamieGeddes', name: 'factorial' } },
    stages: { Build: { startedAt: '2026-11-01T11:01:00Z' } },
    live: { role: 'builder', stage: 'build', round: 1, at: '2026-11-01T11:59:50Z', limits: { maxTurns: 10 } },
  };
  const data = overview({ rows: [row], threads: new Map(), now: Date.parse('2026-11-01T12:00:00Z'), resultSince: '2026-10-01T00:00:00Z' });
  const html = render(<OverviewView initial={data} />);
  assert.match(html, /<h1>Overview<\/h1>/);
  assert.match(html, /Agent sessions running/);
  assert.match(html, new RegExp(`href="/runs/${ID}/build/1"`));
  assert.ok(!html.includes('<img'));
  const detail = runDetail({ row, stage: 'build', round: 1, now: Date.parse('2026-11-01T12:00:00Z'), resultSince: '2026-10-01T00:00:00Z', plan: { steps: [{ id: 'lib', files: ['a.ts'] }], source: 'plan/plan.json' } });
  const run = render(<RunView initial={detail} />);
  assert.match(run, /Find in transcript/);
  assert.match(run, /Jump to latest/);
  assert.match(run, /No events yet: waiting for the run on its channel\./);
  assert.match(run, /<div>lib<\/div><div class="f">a.ts<\/div>/);
  assert.match(run, /Turns<\/span>.*0 \/ 10/);
  assert.ok(!run.includes('<img'));
});

const RUNS_NOW = Date.parse('2026-11-01T12:00:00Z');
const runRow = (n: string, ref: string, createdAt: string, fields: Partial<LedgerRow>): LedgerRow => ({
  workItemId: `${n.repeat(8)}-d53d-11f1-8851-ff488f20a8b2`,
  createdAt,
  workItem: { title: `Title ${n}`, source: { type: 'github-issue', id: ref.slice(1) }, repository: { owner: 'JamieGeddes', name: 'factorial' } },
  ...fields,
});
// a: oldest-but-one, failed; b: newest, running; c: review run, merged-ready; d: oldest, no changes
const RUNS = [
  summarise(runRow('a', '#9', '2026-11-01T09:00:00Z', { result: 'failed', stages: { Build: { startedAt: '2026-11-01T09:01:00Z' } } }), undefined, RUNS_NOW),
  summarise(runRow('b', '#12', '2026-11-01T11:00:00Z', { stages: { 'Build#10': { startedAt: '2026-11-01T11:01:00Z' } }, live: { role: 'builder', stage: 'build', round: 10, at: '2026-11-01T11:59:50Z' } }), undefined, RUNS_NOW),
  summarise(runRow('c', '#100', '2026-11-01T10:00:00Z', { result: 'pr-opened', stages: { Review: { startedAt: '2026-11-01T10:01:00Z' } } }), undefined, RUNS_NOW),
  summarise(runRow('d', '#20', '2026-11-01T08:00:00Z', { result: 'no-changes', stages: { 'Build#2': { startedAt: '2026-11-01T08:01:00Z' } } }), undefined, RUNS_NOW),
];
const letters = (items: { id: string }[]) => items.map((i) => i.id[0]).join('');
const shownOrder = (html: string) => [...html.matchAll(/href="\/runs\/(\w)/g)].map((m) => m[1]).join('');

test('/runs opens newest created first, the running item among the rest with its status pill', () => {
  const html = render(<RunsView items={RUNS} />);
  assert.equal(shownOrder(html), 'bcad');
  assert.match(html, /aria-label="Search runs"/);
  assert.match(html, /aria-label="Filter by status"/);
  const running = RUNS[1]!;
  assert.equal(running.running, true);
  assert.ok(html.includes(running.status.label), html);
  assert.match(html, /<th aria-sort="descending"><button type="button" class="th-sort">Created/);
  for (const header of ['Work item', 'Latest run', 'Status']) assert.match(html, new RegExp(`<th aria-sort="none"><button type="button" class="th-sort">${header}</button></th>`));
});

test('every run column sorts both ways', () => {
  const by = (key: string, dir: 'asc' | 'desc') => letters(sortRows(RUNS, RUN_COLUMNS, { key, dir }));
  // Reference: #9 < #12 < #20 < #100 (digit runs compare as numbers).
  assert.equal(by('item', 'asc'), 'abdc');
  assert.equal(by('item', 'desc'), 'cdba');
  // Latest run: stage, then round: build/1 < build/2 < build/10 < review/1.
  assert.equal(by('run', 'asc'), 'adbc');
  assert.equal(by('run', 'desc'), 'cbda');
  assert.equal(by('created', 'asc'), 'dacb');
  assert.equal(by('created', 'desc'), 'bcad');
  const labels = RUNS.map((r) => r.status.label);
  const sortedLabels = [...labels].sort((x, y) => x.localeCompare(y));
  assert.deepEqual(sortRows(RUNS, RUN_COLUMNS, { key: 'status', dir: 'asc' }).map((r) => r.status.label), sortedLabels);
  assert.deepEqual(sortRows(RUNS, RUN_COLUMNS, { key: 'status', dir: 'desc' }).map((r) => r.status.label), sortedLabels.reverse());
});

test('an item without a created time or a run sorts last whichever way', () => {
  const { createdAt: _created, ...undated } = runRow('e', '#1', '', { stages: { Build: { startedAt: '2026-11-01T07:00:00Z' } } });
  const items = [...RUNS, summarise(undated, undefined, RUNS_NOW)];
  assert.equal(letters(sortRows(items, RUN_COLUMNS, { key: 'created', dir: 'desc' })), 'bcade');
  assert.equal(letters(sortRows(items, RUN_COLUMNS, { key: 'created', dir: 'asc' })), 'dacbe');
});

test('the runs empty states say which filters are active', () => {
  assert.match(render(<RunsView items={[]} />), /No item has an agent run yet\./);
  const html = render(<RunsTable items={[]} empty={runsEmptyMessage({ filter: 'running', q: 'abc' })} />);
  assert.match(html, /No runs match\. Clear the Running filter or the search “abc” to see more\./);
});
