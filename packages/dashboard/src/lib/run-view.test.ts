import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { LedgerRow } from './records.ts';
import { itemRuns, limitsOf, runDetail, runEnded, timeline, transcriptPath } from './run-view.ts';
import { graphStage, percentile, stageDurations } from './stages.ts';
import { emptyWatch, retryNotices, watchEvent } from './run-watch.ts';

const ID = '7f93ccb0-d53d-11f1-8851-ff488f20a8b2';
const OTHER = 'c8db78d0-d53d-11f1-8851-ff488f20a8b2';
const NOW = Date.parse('2026-11-01T12:00:00Z');

const row: LedgerRow = {
  workItemId: ID,
  createdAt: '2026-11-01T11:00:00Z',
  attempt: 1,
  artefactPrefix: `${ID}/1/`,
  executionArn: 'arn:aws:states:eu-west-1:000000000000:execution:factorial-work:abc',
  branch: 'factorial/x',
  workItem: { title: 'Do it', source: { type: 'github-issue', id: '12' }, repository: { owner: 'JamieGeddes', name: 'factorial' } },
  stages: {
    Intake: { startedAt: '2026-11-01T11:00:00Z', endedAt: '2026-11-01T11:00:02Z', outcome: 'succeeded' },
    Prepare: { startedAt: '2026-11-01T11:00:05Z', endedAt: '2026-11-01T11:00:55Z', outcome: 'succeeded' },
    Build: { startedAt: '2026-11-01T11:01:30Z', endedAt: '2026-11-01T11:30:00Z', outcome: 'failed', run: { runtimeName: 'factorial_builder', runtimeVersion: '46', sessionId: ID, transcriptKey: `${ID}/1/build/transcript.jsonl`, usageKey: `${ID}/1/build/usage.json`, turns: 150 } },
    'Build#2': { startedAt: '2026-11-01T11:31:00Z' },
  },
  live: { role: 'builder', stage: 'build', round: 2, at: '2026-11-01T11:59:50Z', limits: { maxTurns: 150, maxBudgetUsd: 5, maxDurationSeconds: 6600 } },
};

test('the timeline shows each stage as work and the wait since the one before, then the stages not reached', () => {
  const rows = timeline(row);
  assert.deepEqual(rows.slice(0, 4).map((r) => [r.name, r.state, r.waitSeconds]), [
    ['Intake', 'done', undefined],
    ['Prepare', 'done', 3],
    ['Build', 'failed', 35],
    ['Build r2', 'live', 60],
  ]);
  assert.deepEqual(rows.slice(4).map((r) => [r.name, r.state]), [
    ['Collect', 'todo'],
    ['Test', 'todo'],
    ['Prepare review', 'todo'],
    ['Review', 'todo'],
    ['Collect review', 'todo'],
    ['Open PR', 'todo'],
  ]);
});

test('a run has ended once its stage entry closes, its live record ends, or the item has a result', () => {
  assert.ok(runEnded(row, 'build', 1));
  assert.ok(!runEnded(row, 'build', 2));
  assert.ok(runEnded({ ...row, live: { ...row.live, ended: true } }, 'build', 2));
  assert.ok(runEnded({ ...row, result: 'failed' }, 'build', 2));
  assert.ok(!runEnded(row, 'review', 1));
});

test("a run's transcript path comes from its record, or from its folder", () => {
  assert.equal(transcriptPath(row, 'build', 1), '1/build/transcript.jsonl');
  assert.equal(transcriptPath(row, 'build', 2), '1/build/round-2/transcript.jsonl');
  assert.equal(transcriptPath({ ...row, stages: { Build: { run: { transcriptKey: 'elsewhere/x/transcript.jsonl' } } } }, 'build', 1), '1/build/transcript.jsonl');
});

test('the detail: header, links, limits from the live record, the transcript once ended, and the runs to switch to', () => {
  const other: LedgerRow = { workItemId: OTHER, live: { stage: 'review', round: 1 } };
  const live = runDetail({ row, stage: 'build', round: 2, bucket: 'factorial-work-artefacts-x', running: [row, other], now: NOW, resultSince: '2026-10-01T00:00:00Z' });
  assert.equal(live.title, 'Do it');
  assert.equal(live.ref, '#12');
  assert.equal(live.status.label, 'building r2');
  assert.equal(live.channel, `/factorial/runs/${ID}/build/2`);
  assert.equal(live.ended, false);
  assert.equal(live.transcript, undefined);
  assert.deepEqual(live.limits, { maxTurns: 150, maxBudgetUsd: 5, maxDurationSeconds: 6600 });
  assert.ok(live.links.execution?.includes('/states/home?region=eu-west-1#/v2/executions/details/arn:aws:states:'));
  assert.ok(live.links.artefacts?.includes('prefix=7f93ccb0'));
  assert.deepEqual(
    live.options.map((o) => [o.label, o.group, o.current]),
    [
      ['7f93ccb0 · builder · build/1 (finished)', 'item', false],
      ['7f93ccb0 · builder · build/2 (live)', 'item', true],
      ['c8db78d0 · reviewer · review/1 (live)', 'running', false],
    ],
  );
  const done = runDetail({ row, stage: 'build', round: 1, storedLimits: { maxTurns: 150 }, now: NOW, resultSince: '2026-10-01T00:00:00Z' });
  assert.equal(done.transcript, `/api/work-items/${ID}/artefacts/1/build/transcript.jsonl`);
  assert.deepEqual(done.limits, { maxTurns: 150 });
  assert.equal(done.record?.runtimeVersion, '46');
  assert.equal(done.sessionId, ID);
  assert.deepEqual(itemRuns(row, { stage: 'review', round: 1 }).map((r) => `${r.stage}/${r.round}`), ['build/1', 'build/2', 'review/1']);
  assert.deepEqual(limitsOf({ maxTurns: 60, maxBudgetUsd: 2, other: 1 }), { maxTurns: 60, maxBudgetUsd: 2 });
  assert.equal(limitsOf({}), undefined);
});

test('stage durations: the median and 90th percentile over the last runs, rounds counted as runs', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(percentile([], 50), undefined);
  const build = stageDurations([row]).find((d) => d.stage === 'Build');
  assert.deepEqual(build, { stage: 'Build', p50: 1710, p90: 1710, runs: 1 });
  const windowed = stageDurations([row, { workItemId: OTHER, stages: { Intake: { startedAt: '2026-11-01T10:00:00Z', endedAt: '2026-11-01T10:00:10Z' } } }], 1).find((d) => d.stage === 'Intake');
  assert.equal(windowed?.p50, 2, 'only the latest run');
  assert.equal(graphStage('ContinueBuild'), 'Build');
  assert.equal(graphStage('SaveWork'), 'Build');
  assert.equal(graphStage('ReportFailure'), undefined);
});

test('a watched session counts its turns once, and its retries become a notice that clears', () => {
  const channel = `/factorial/runs/${ID}/build/1`;
  let watch = emptyWatch();
  const at = (s: number) => new Date(NOW - s * 1000).toISOString();
  watch = watchEvent(watch, { seq: 1, at: at(400), event: { type: 'model.call' } });
  watch = watchEvent(watch, { seq: 2, at: at(390), event: { type: 'model.call', agentId: 'a' } });
  watch = watchEvent(watch, { seq: 3, at: at(380), event: { type: 'model.retry', status: 429 } });
  watch = watchEvent(watch, { seq: 1, at: at(400), event: { type: 'model.call' } });
  assert.equal(watch.turns, 1);
  assert.equal(watch.last?.text, 'model call retried');
  const cleared = retryNotices({ [channel]: watch }, NOW);
  assert.equal(cleared[0]?.tone, 'ok');
  assert.match(cleared[0]?.text ?? '', /^Model call retries stopped for 7f93ccb0: 1 retry in the last hour, none since \d\d:\d\d$/);
  const retrying = retryNotices({ [channel]: watchEvent(watch, { seq: 4, at: at(10), event: { type: 'model.retry', status: 503 } }) }, NOW);
  assert.deepEqual([retrying[0]?.tone, retrying[0]?.text, retrying[0]?.href], ['warn', 'Model calls retrying for 7f93ccb0 (HTTP 503): 2 retries in the last hour', `/runs/${ID}/build/1`]);
});
