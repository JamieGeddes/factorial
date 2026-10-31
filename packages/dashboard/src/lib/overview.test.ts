import assert from 'node:assert/strict';
import { test } from 'node:test';

import { overview, roughDur } from './overview.ts';
import type { LedgerRow, ThreadRow } from './records.ts';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const id = (n: number) => `0000000${n}-d53d-11f1-8851-ff488f20a8b2`;
const repo = { owner: 'JamieGeddes', name: 'factorial' };
const row = (n: number, fields: Partial<LedgerRow>): LedgerRow => ({
  workItemId: id(n),
  attempt: 1,
  artefactPrefix: `${id(n)}/1/`,
  workItem: { title: `item ${n}`, source: { type: 'github-issue', id: String(n) }, repository: repo },
  ...fields,
});

const building = row(1, {
  createdAt: '2026-11-01T11:00:00Z',
  stages: {
    Intake: { startedAt: '2026-11-01T11:00:00Z', endedAt: '2026-11-01T11:00:01Z' },
    Build: { startedAt: '2026-11-01T11:01:00Z', endedAt: '2026-11-01T11:20:00Z', outcome: 'failed', run: { costUsd: 0.8, usage: { inputTokens: 1000, outputTokens: 100, cacheReadInputTokens: 900 } } },
    'Build#2': { startedAt: '2026-11-01T11:21:00Z' },
  },
  live: { role: 'builder', stage: 'build', round: 2, at: '2026-11-01T11:59:40Z', costUsd: 0.4, elapsedSeconds: 2300, usage: { inputTokens: 1000, outputTokens: 50, cacheReadInputTokens: 500 }, limits: { maxTurns: 150, maxBudgetUsd: 5, maxDurationSeconds: 6600 }, lastEvent: { type: 'tool.call' } },
});
const testing = row(2, {
  createdAt: '2026-11-01T11:10:00Z',
  workItem: { title: 'rework', source: { type: 'github-pull-request-review', id: 'r' }, repository: repo, inReplyTo: { kind: 'pull-request', number: 9 } },
  threadKey: 't1',
  testRunUrl: 'https://github.com/JamieGeddes/factorial/actions/runs/123',
  stages: { Build: { startedAt: '2026-11-01T11:11:00Z', endedAt: '2026-11-01T11:29:00Z' }, Test: { startedAt: '2026-11-01T11:30:00Z' } },
});
const refused = row(3, { createdAt: '2026-11-01T11:50:00Z', endedAt: '2026-11-01T11:50:01Z', result: 'refused', route: 'refuse', status: 'busy', refusedReason: 'the thread is busy', threadKey: 't1' });
const opened = row(4, {
  createdAt: '2026-11-01T09:20:00Z',
  endedAt: '2026-11-01T10:00:00Z',
  result: 'pr-opened',
  threadKey: 't4',
  workItem: { title: 'opened', createdAt: '2026-11-01T09:20:00Z', source: { type: 'github-issue', id: '4' }, repository: repo },
  stages: {
    Build: { startedAt: '2026-11-01T09:21:00Z', endedAt: '2026-11-01T09:50:00Z', run: { costUsd: 1.5, usage: { inputTokens: 2000, outputTokens: 200, cacheReadInputTokens: 1600 } } },
    Test: { startedAt: '2026-11-01T09:51:00Z', endedAt: '2026-11-01T09:55:00Z' },
  },
});
const failed = row(5, { createdAt: '2026-11-01T11:00:00Z', endedAt: '2026-11-01T11:30:00Z', result: 'tests-failed', stages: { Test: { startedAt: '2026-11-01T11:20:00Z', endedAt: '2026-11-01T11:24:00Z' } } });
const yesterday = row(6, {
  createdAt: '2026-10-31T09:00:00Z',
  endedAt: '2026-10-31T10:00:00Z',
  result: 'pr-opened',
  stages: { Build: { startedAt: '2026-10-31T09:01:00Z', endedAt: '2026-10-31T09:40:00Z', run: { costUsd: 2 } } },
});
const stale = row(7, {
  createdAt: '2026-11-01T11:30:00Z',
  stages: { Review: { startedAt: '2026-11-01T11:40:00Z' } },
  live: { role: 'reviewer', stage: 'review', round: 1, at: '2026-11-01T11:55:00Z' },
});

const threads = new Map<string, ThreadRow>([
  ['t1', { threadKey: 't1', branch: 'factorial/x', inFlight: { workItemId: id(2) } }],
  ['t4', { threadKey: 't4', outcome: { state: 'merged', at: '2026-11-01T11:00:00Z', by: 'jamie' } }],
]);

const view = overview({ rows: [building, testing, refused, opened, failed, yesterday, stale], threads, now: NOW, resultSince: '2026-10-01T00:00:00Z', alarms: [{ name: 'factorial-report-dlq', since: '2026-11-01T11:45:00Z' }] });
const tile = (label: string) => view.tiles.find((t) => t.label === label);

test('the tiles count what is in flight, what finished today against yesterday, and pull requests opened', () => {
  assert.deepEqual(tile('In flight'), { label: 'In flight', value: '3', spark: tile('In flight')?.spark, delta: { text: 'across 1 repository' } });
  assert.equal(tile('In flight')?.spark.length, 8);
  assert.deepEqual(tile('Finished today')?.delta, { figure: '+2', good: true, text: 'vs yesterday' });
  assert.equal(tile('Finished today')?.value, '3');
  assert.equal(tile('Pull requests opened')?.value, '1');
  assert.equal(tile('Pull requests opened')?.delta?.text, '1 merged, 0 awaiting review');
});

test('spend today is the runs that ended today plus a running run not yet recorded, against the 7-day mean', () => {
  assert.equal(tile('Model spend today')?.value, '$2.70');
  assert.equal(tile('Model spend today')?.delta?.good, false);
  assert.equal(tile('Model spend today')?.delta?.text, 'vs 7-day mean');
  assert.equal(tile('Tokens today')?.value, '4.3K');
  assert.equal(tile('Tokens today')?.delta?.text, 'cache hit 75%');
});

test('the median issue to PR runs from the WorkItem to its pr-opened result, today against last week', () => {
  assert.equal(tile('Median issue to PR')?.value, '40m');
  assert.deepEqual(tile('Median issue to PR')?.delta, { figure: '−20m', good: true, text: 'vs last week' });
  assert.equal(roughDur(42), '42s');
  assert.equal(roughDur(3900), '1h 05m');
});

test('one puck per item in flight, on its stage, styled by kind, with its build round', () => {
  const pucks = Object.fromEntries(view.pucks.map((p) => [p.id, p]));
  assert.equal(pucks[id(1)]?.stage, 'Build');
  assert.equal(pucks[id(1)]?.round, 2);
  assert.equal(pucks[id(1)]?.kind, 'builder');
  assert.equal(pucks[id(1)]?.href, `/runs/${id(1)}/build/2`);
  assert.equal(pucks[id(2)]?.stage, 'Test');
  assert.equal(pucks[id(2)]?.kind, 'waiting');
  assert.equal(pucks[id(7)]?.kind, 'reviewer');
  assert.equal(view.pucks.length, 3);
});

test('attention lists refusals with the thread holder, failed outcomes, a stopped invoker, a long Test and alarms, newest first', () => {
  const texts = view.notices.map((n) => `${n.tone}: ${n.text}`);
  assert.ok(texts.includes(`info: Intake refused 00000003 (busy): thread factorial/x is held by 00000002. the thread is busy`), texts.join('\n'));
  assert.ok(texts.some((t) => t.startsWith('crit: 00000005 ended tests-failed in Test')));
  assert.ok(texts.some((t) => t.startsWith("crit: 00000007's run has not reported for 5m 00s")));
  assert.ok(texts.some((t) => t.startsWith('warn: Test stage waiting 30m 00s on GitHub Actions for 00000002')));
  assert.ok(texts.includes('crit: CloudWatch alarm factorial-report-dlq is in ALARM'));
  assert.deepEqual([...view.notices].sort((a, b) => b.at.localeCompare(a.at)), view.notices);
  assert.ok(!texts.some((t) => t.includes('00000006')), 'yesterday is outside the hour');
});

test('sessions: one row per running agent run with its limits, and a row for an item in Test', () => {
  const rows = Object.fromEntries(view.sessions.map((s) => [s.id, s]));
  assert.equal(rows[id(1)]?.kind, 'agent');
  assert.equal(rows[id(1)]?.round, 2);
  assert.equal(rows[id(1)]?.startedAt, '2026-11-01T11:21:00Z');
  assert.equal(rows[id(1)]?.channel, `/factorial/runs/${id(1)}/build/2`);
  assert.deepEqual(rows[id(1)]?.limits, { maxTurns: 150, maxBudgetUsd: 5, maxDurationSeconds: 6600 });
  assert.equal(rows[id(2)]?.kind, 'test');
  assert.deepEqual(rows[id(2)]?.testRun, { id: '123', url: 'https://github.com/JamieGeddes/factorial/actions/runs/123' });
  assert.equal(rows[id(7)]?.role, 'reviewer');
});

test('throughput, spend and recently finished cover the last 14 days and today', () => {
  assert.equal(view.throughput.labels.length, 14);
  assert.equal(view.throughput.labels.at(-1), '1/11');
  assert.equal(view.throughput.prOpened.at(-1), 1);
  assert.equal(view.throughput.noPr.at(-1), 2);
  assert.equal(view.throughput.prOpened.at(-2), 1);
  assert.equal(view.spend.values.at(-2), 2);
  assert.deepEqual(view.recent.map((r) => r.id), [id(3), id(5), id(4)]);
  assert.equal(view.recent[2]?.durationSeconds, 2400);
  const build = view.stages.find((s) => s.stage === 'Build');
  assert.equal(build?.runs, 4);
});

test('a refused title or reason with markup stays text for React to escape', () => {
  const hostile = overview({ rows: [row(8, { createdAt: '2026-11-01T11:59:00Z', result: 'refused', refusedReason: 'a‮<img src=x onerror=alert(1)>' })], threads: new Map(), now: NOW });
  assert.ok(hostile.notices[0]?.text.endsWith('a<img src=x onerror=alert(1)>'));
});
