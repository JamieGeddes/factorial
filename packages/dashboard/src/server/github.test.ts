import assert from 'node:assert/strict';
import { test } from 'node:test';

import { commitTitle, createGitHub, parsePromoted, parseStacks, type Fetch } from './github.ts';

const SHA = 'aea138a0123456789abcdef0123456789abcdef0';

function fakeFetch(routes: Record<string, unknown>, headers: Record<string, string> = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const path = url.replace('https://api.github.com/repos/JamieGeddes/factorial', '');
    const body = routes[path];
    return { ok: body !== undefined, status: body !== undefined ? 200 : 404, headers: { get: (name: string) => headers[name] ?? null }, json: async () => body };
  };
  return { fetch, calls };
}

const runs = {
  workflow_runs: [
    { id: 3, run_attempt: 1, head_sha: SHA, head_commit: { message: 'Merge pull request #236 from JamieGeddes/x\n\nbody' }, run_started_at: '2026-10-31T20:11:27Z', status: 'completed', conclusion: 'success' },
    { id: 2, run_attempt: 2, head_sha: SHA, head_commit: { message: 'Docs' }, run_started_at: '2026-10-31T19:00:00Z', status: 'completed', conclusion: 'success' },
    { id: 1, run_attempt: 1, head_sha: SHA, head_commit: { message: 'Live run feed (#223)' }, run_started_at: '2026-10-31T13:42:35Z', status: 'completed', conclusion: 'failure' },
    { id: 4, run_attempt: 1, head_sha: SHA, head_commit: { message: 'Running' }, run_started_at: '2026-10-31T21:00:00Z', status: 'in_progress', conclusion: null },
    { id: 5, head_sha: 'not a sha' },
  ],
};
const routes = {
  '/actions/workflows/deploy.yml/runs?branch=main&per_page=10': runs,
  '/actions/runs/3/attempts/1/jobs': { jobs: [{ id: 30, name: 'Compare against the last deployed commit', conclusion: 'success' }, { id: 31, name: 'Deploy Factorial stacks', conclusion: 'success' }] },
  '/check-runs/31/annotations?per_page=50': [
    { annotation_level: 'notice', title: 'Stacks deployed', message: 'agent orchestration' },
    { annotation_level: 'notice', title: 'Runtimes promoted', message: 'factorial_builder 47, factorial_reviewer 31' },
    { annotation_level: 'warning', title: 'Runtimes promoted', message: 'factorial_builder 1' },
  ],
  '/actions/runs/2/attempts/2/jobs': { jobs: [{ id: 20, name: 'Deploy Factorial stacks', conclusion: 'skipped' }] },
  '/actions/runs/1/attempts/1/jobs': { jobs: [{ id: 10, name: 'Deploy Factorial stacks', conclusion: 'failure' }] },
  '/check-runs/10/annotations?per_page=50': [],
};

test('deploy runs: stacks and promotions from their notices, skipped and failed runs, finished runs read once', async () => {
  const { fetch, calls } = fakeFetch(routes);
  const gh = createGitHub({ repository: 'JamieGeddes/factorial', fetch, ttlMs: 0 });
  const list = await gh.deploys();
  assert.deepEqual(
    list.map((d) => [d.id, d.status, d.stacks, d.promoted]),
    [
      [3, 'deployed', ['agent', 'orchestration'], [{ runtime: 'factorial_builder', version: '47' }, { runtime: 'factorial_reviewer', version: '31' }]],
      [2, 'skipped', undefined, undefined],
      [1, 'failed', undefined, undefined],
      [4, 'running', undefined, undefined],
    ],
  );
  assert.equal(list[0]?.title, 'Merge PR #236: body');
  assert.equal(list[2]?.title, 'Live run feed (#223)');
  assert.equal(list[1]?.attempt, 2);
  const first = calls.length;
  await gh.deploys();
  // Only the list again: every finished run's jobs and annotations are kept.
  assert.equal(calls.length - first, 1);
  assert.ok(calls.every((c) => c.headers.authorization === undefined));
});

test('a token is sent when the environment has one, and a spent rate limit says how to raise it', async () => {
  const { fetch, calls } = fakeFetch({});
  const limited: Fetch = async () => ({ ok: false, status: 403, headers: { get: (n: string) => (n === 'x-ratelimit-remaining' ? '0' : null) }, json: async () => ({}) });
  await assert.rejects(createGitHub({ repository: 'JamieGeddes/factorial', fetch: limited }).deploys(), /rate limit reached; set GITHUB_TOKEN/);
  await assert.rejects(createGitHub({ repository: 'JamieGeddes/factorial', fetch, token: 't0ken' }).deploys(), /returned 404/);
  assert.equal(calls[0]?.headers.authorization, 'Bearer t0ken');
  assert.throws(() => createGitHub({ repository: '../evil' }), /not a repository/);
});

test('commit titles', () => {
  assert.equal(commitTitle('Merge pull request #236 from JamieGeddes/factorial/ae08ce40\n\nCommand centre: Ctrl-C hangs'), 'Merge PR #236: Command centre: Ctrl-C hangs');
  assert.equal(commitTitle('Merge pull request #1 from x/y'), 'Merge pull request #1 from x/y');
  assert.equal(commitTitle('Fix it\n\nbody'), 'Fix it');
});

test('notice messages', () => {
  assert.deepEqual(parseStacks('none'), []);
  assert.deepEqual(parseStacks('triggers agent <b>'), ['triggers', 'agent']);
  assert.deepEqual(parsePromoted('none'), []);
  assert.deepEqual(parsePromoted('factorial_builder 47, bad, factorial_reviewer x'), [{ runtime: 'factorial_builder', version: '47' }]);
});
