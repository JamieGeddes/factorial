import assert from 'node:assert/strict';
import { test } from 'node:test';

import { metrics } from './metrics.ts';
import type { LedgerRow, ThreadRow } from './records.ts';
import type { UsageFacts } from './usage-facts.ts';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const id = (n: number) => `0000000${n}-d53d-11f1-8851-ff488f20a8b2`;
const repo = { owner: 'JamieGeddes', name: 'factorial' };
const at = (day: number, hour: number) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();

const build = (n: number, day: number, fields: Record<string, unknown> = {}) => ({
  startedAt: at(day, 10),
  endedAt: at(day, 11),
  run: { role: 'builder', runtimeName: 'factorial_builder', runtimeVersion: '47', harness: { name: 'pi', version: '0.9.2' }, modelId: 'global.anthropic.claude-sonnet-5-5', durationSeconds: 1200, costUsd: 2, usage: { inputTokens: 1000, outputTokens: 100 }, usageKey: `${id(n)}/1/build/usage.json`, outcome: 'complete' as const, ...fields },
});
const review = (n: number, day: number) => ({
  startedAt: at(day, 11),
  endedAt: at(day, 11),
  run: { role: 'reviewer', runtimeName: 'factorial_reviewer', runtimeVersion: '31', durationSeconds: 300, costUsd: 0.5, usage: { inputTokens: 100, outputTokens: 10 }, usageKey: `${id(n)}/1/review/usage.json` },
});

const row = (n: number, fields: Partial<LedgerRow>): LedgerRow => ({
  workItemId: id(n),
  attempt: 1,
  createdAt: at(fields.endedAt ? new Date(fields.endedAt).getUTCDate() : 30, 9),
  workItem: { title: `item ${n}`, createdAt: at(fields.endedAt ? new Date(fields.endedAt).getUTCDate() : 30, 9), source: { type: 'github-issue', id: String(n) }, repository: repo },
  ...fields,
});

const rows: LedgerRow[] = [
  row(1, { result: 'pr-opened', endedAt: at(31, 12), threadKey: 't1', stages: { Build: build(1, 31), Review: review(1, 31) }, reviewScores: { correctness: 4, completeness: 4, tests: 3, safety: 5 } }),
  row(2, { result: 'pr-opened', endedAt: at(30, 12), threadKey: 't2', buildRounds: 2, stages: { Build: build(2, 30, { stopReason: 'max_turns', outcome: 'incomplete' }), 'Build#2': build(2, 30, { usageKey: `${id(2)}/1/build/round-2/usage.json` }) } }),
  row(3, { result: 'failed', savedWork: true, branch: 'factorial/x', endedAt: at(29, 12), stages: { Build: build(3, 29, { outcome: 'failed', runtimeVersion: '46' }) } }),
  row(4, { result: 'refused', status: 'busy', endedAt: at(31, 9) }),
  row(5, { result: 'pr-updated', endedAt: at(31, 13), workItem: { title: 'rework', source: { type: 'github-workflow-run', id: 'w' }, repository: repo }, stages: { Build: build(5, 31) } }),
  row(6, { result: 'pr-opened', endedAt: at(31, 13), workItem: { title: 'other repo', source: { type: 'github-issue', id: '9' }, repository: { owner: 'acme', name: 'billing' } } }),
  // Ended before the 7-day range.
  row(7, { result: 'pr-opened', endedAt: at(1, 12), stages: { Build: build(7, 1) } }),
];
const threads = new Map<string, ThreadRow>([
  ['t1', { threadKey: 't1', outcome: { state: 'merged', at: at(31, 14), by: 'jamie' } }],
  ['t2', { threadKey: 't2' }],
]);
const facts = (fields: Partial<UsageFacts>): UsageFacts => ({ models: [], timed: [], untimed: 0, configured: [], ...fields });
const records = new Map<string, UsageFacts>([
  [`${id(1)}/1/build/usage.json`, facts({ models: [{ model: 'global.anthropic.claude-sonnet-5-5', tokens: 1100 }, { model: 'global.anthropic.claude-haiku-5-5', tokens: 50 }], timed: [['global.anthropic.claude-sonnet-5-5', 8000], ['global.anthropic.claude-sonnet-5-5', 10000]], retries: 2 })],
  [`${id(2)}/1/build/usage.json`, facts({ untimed: 40 })],
  [`${id(3)}/1/build/usage.json`, facts({ retries: 3, timed: [['global.anthropic.claude-sonnet-5-5', 4000]] })],
]);

test('the tiles over 7 days, one repository', () => {
  const m = metrics({ rows, threads, records, now: NOW, range: 7, repository: 'jamiegeddes/factorial' });
  assert.equal(m.repository, 'JamieGeddes/factorial');
  assert.deepEqual(m.repositories, ['acme/billing', 'JamieGeddes/factorial']);
  const tile = (label: string) => m.tiles.find((t) => t.label === label);
  // Items 1, 2 (opened) and 5 (updated): $2.50, $4.00, $2.00.
  assert.equal(tile('Cost per pull request')?.value, '$2.50');
  assert.equal(tile('Cost per pull request')?.delta?.text, 'median of 3, 7 days');
  // Items 1 and 2: 3 hours each.
  assert.equal(tile('Issue to PR, median')?.value, '3h 00m');
  assert.equal(tile('PR merge rate')?.value, '50%');
  assert.equal(tile('PR merge rate')?.delta?.text, '1 of 2 opened');
  assert.equal(tile('Rework turns per PR')?.value, '0.5');
  assert.equal(tile('Rework turns per PR')?.delta?.text, 'automatic 0.5, requested 0.0');
  // Builds: 1, 2, 3 and 5; item 2 took two rounds after running out of turns.
  assert.equal(tile('Builds needing rounds')?.value, '25%');
  assert.equal(tile('Builds needing rounds')?.delta?.text, '1 of 4, 1 ran out of turns');
  // Retries recorded on items 1 and 3; item 3's run failed.
  assert.equal(tile('Model call retries')?.value, '5');
  assert.equal(tile('Model call retries')?.delta?.text, '2 runs retried, 1 still failed');
});

test('the charts: tokens by model, cost by role, outcomes, scores, latency and the note on untimed runs', () => {
  const m = metrics({ rows, threads, records, now: NOW, range: 7, repository: 'JamieGeddes/factorial' });
  assert.equal(m.bucket, 'day');
  assert.equal(m.tokens.labels.length, 7);
  // The reviewer's entry names no model and it has no record.
  assert.deepEqual(m.tokens.series.map((s) => s.name), ['Sonnet 5.5 global', 'Model not recorded', 'Haiku 5.5 global']);
  // 31 October: item 1's harness totals and item 5's ledger figures (no record).
  assert.equal(m.tokens.series[0]?.values[5], 1100 + 1100);
  assert.deepEqual(m.costByRole.series.map((s) => s.name), ['Builder', 'Reviewer']);
  assert.equal(m.costByRole.labels.length, 4);
  assert.deepEqual(m.outcomes.map((o) => [o.name, o.v]), [['PR opened', 2], ['PR updated', 1], ['Incomplete', 1], ['Refused', 1]]);
  assert.deepEqual(m.scores.series.map((s) => s.name), ['Correctness', 'Completeness', 'Tests', 'Safety']);
  assert.ok(m.scores.series[0]?.values.includes(4));
  const sonnet = m.latency.series.find((s) => s.name === 'Sonnet 5.5 global p50 s');
  assert.equal(sonnet?.values[5], 9);
  assert.equal(sonnet?.values[4], null);
  assert.equal(m.latency.retries[5], 2);
  assert.equal(m.latency.retries[4], null);
  assert.ok(m.notes.some((n) => n.startsWith('1 run in the range recorded no per-call model or latency')), m.notes.join('\n'));
});

test('Runtime versions compared, builder role first, newest first', () => {
  const m = metrics({ rows, threads, records, now: NOW, range: 30, promotions: new Map([['factorial_builder 47', at(28, 18)]]), created: { builder: { '46': at(20, 10) } } });
  assert.deepEqual(m.versions.roles, ['builder', 'reviewer']);
  const builder = m.versions.byRole.builder ?? [];
  assert.deepEqual(builder.map((v) => v.version), ['47', '46']);
  const v47 = builder[0];
  assert.equal(v47?.promoted?.source, 'deploy');
  assert.equal(v47?.harness, 'pi 0.9.2');
  assert.equal(v47?.model, 'Sonnet 5.5 global');
  // Items 1, 2 (two rounds) and 5 (item 7 ended before the range): three PRs over three finished items.
  assert.equal(v47?.runs, 4);
  assert.equal(v47?.prRate, 100);
  assert.equal(v47?.roundsPerBuild, 1.3);
  assert.equal(v47?.costPerPr, 2.67);
  assert.equal(v47?.medianSeconds, 1200);
  assert.equal(builder[1]?.promoted?.source, 'created');
  assert.equal(builder[1]?.prRate, 0);
  assert.deepEqual(m.versions.byRole.reviewer?.map((v) => v.version), ['31']);
  assert.equal(m.versions.byRole.reviewer?.[0]?.roundsPerBuild, undefined);
});

test('90 days are drawn per week, and an unknown repository means all of them', () => {
  const m = metrics({ rows, threads, records, now: NOW, range: 90, repository: 'nobody/nothing' });
  assert.equal(m.bucket, 'week');
  assert.equal(m.tokens.labels.length, 13);
  assert.equal(m.repository, '');
  assert.equal(m.outcomes.reduce((a, o) => a + o.v, 0), 7);
});

test('no merge rate when no thread records an outcome, and no cost for items that recorded none', () => {
  const bare = rows.map((r) => (r.workItemId === id(1) ? { ...r, threadKey: 't2' } : r));
  const old = row(8, { result: 'pr-opened', endedAt: at(31, 12) });
  const m = metrics({ rows: [...bare, old], threads, records, now: NOW, range: 7, repository: 'JamieGeddes/factorial' });
  const tile = (label: string) => m.tiles.find((t) => t.label === label);
  assert.equal(tile('PR merge rate')?.value, '–');
  assert.equal(tile('PR merge rate')?.delta?.text, '3 opened, no outcome recorded');
  assert.equal(tile('Cost per pull request')?.delta?.text, 'median of 3, 7 days');
});
