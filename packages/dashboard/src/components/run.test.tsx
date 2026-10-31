import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { VirtualList } from '../client/virtual-list.tsx';
import { overview } from '../lib/overview.ts';
import { runDetail } from '../lib/run-view.ts';
import { describe, type RunEvent } from '../lib/transcript.ts';
import { StageGraph } from './overview/StageGraph.tsx';
import { OverviewView } from './overview/OverviewView.tsx';
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
