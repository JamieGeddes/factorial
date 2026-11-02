import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ReworkContext, WorkItem } from '@factorial/workitem';
import { type CheckJob, GitHubClient } from '@factorial/github-app';

import { MAX_REWORK_BYTES, buildReworkFile, detailsFor, initialNotes, logSection } from '../lib/seed-providers.ts';

const TOKEN = `ghs_${'t'.repeat(36)}`;
const HEAD_SHA = 'b'.repeat(40);

const rework: ReworkContext = {
  kind: 'rework',
  pullRequest: { number: 26, url: 'https://github.com/JamieGeddes/factorial/pull/26' },
  branch: 'factorial/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  baseBranch: 'main',
  previousWorkItemId: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  cause: 'review',
  details: [
    { author: 'JamieGeddes', path: 'packages/invoker/src/prompt.ts', line: 12, body: 'Please name the prompt file explicitly.' },
    { author: 'other-user', body: 'Overall looks good.' },
  ],
};

describe('initialNotes', () => {
  const workItem: WorkItem = {
    schemaVersion: 1,
    id: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
    source: { type: 'github-issue', id: '7', url: 'https://github.com/JamieGeddes/factorial/issues/7' },
    repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' },
    title: 'Fix typo',
    body: 'The word "recieve" should be "receive".',
    requestedBy: 'JamieGeddes',
    createdAt: '2026-10-17T09:00:00Z',
  };

  it('opens with the full request, then a plan section and a notes section', () => {
    const notes = initialNotes(workItem);
    assert.match(notes, /^# Task\n/);
    assert.match(notes, /Source: https:\/\/github\.com\/JamieGeddes\/factorial\/issues\/7/);
    assert.match(notes, /## Fix typo\n\nThe word "recieve" should be "receive"\./);
    assert.ok(notes.indexOf('# Task') < notes.indexOf('# Plan'));
    assert.ok(notes.indexOf('# Plan') < notes.indexOf('# Notes'));
    assert.doesNotMatch(notes, /rework\.md/);
  });

  it('marks an empty body explicitly', () => {
    assert.match(initialNotes({ ...workItem, body: ' ' }), /_No further description was given\._/);
  });

  it('points rework items at rework.md', () => {
    assert.match(initialNotes(workItem, { rework: true }), /every numbered point in \/workspace\/rework\.md must be addressed, and answered by its number under `## Rework points` in summary\.md/);
  });

  it('tells a resumed attempt what the previous one did and to continue from it', () => {
    const notes = initialNotes(workItem, {
      resumedFrom: { workItemId: 'a1', status: 'failed', savedWork: true, branch: 'factorial/a1' },
    });
    assert.match(notes, /# Previous attempt\n\nThis continues work item a1, which stopped before finishing\./);
    assert.match(notes, /git log --oneline origin\/HEAD\.\.HEAD/);
    assert.match(notes, /Do not redo work that is already committed/);
    assert.ok(notes.indexOf('# Previous attempt') < notes.indexOf('# Plan'));
    assert.doesNotMatch(initialNotes(workItem), /Previous attempt/);
  });

  it('tells the builder where its plan goes and to keep a line per step', () => {
    assert.match(initialNotes(workItem), /Your plan, from the plan subagent, goes in \/workspace\/plan\.json and \/workspace\/plan\.md: follow its steps in order by `id`/);
    assert.match(initialNotes(workItem), /Keep a line here per step/);
  });

  it('tells the reviewer where the plan is and that its review goes elsewhere', () => {
    const notes = initialNotes(workItem, { role: 'reviewer' });
    assert.match(notes, /The plan the builder followed is \/workspace\/plan\.json/);
    assert.match(notes, /Your review goes in \/workspace\/review\.json, not here/);
    assert.doesNotMatch(notes, /follow its steps/);
  });
});

describe('logSection', () => {
  const job: CheckJob = { id: 4242, name: 'npm test', htmlUrl: 'https://github.com/JamieGeddes/factorial/job/4242', conclusion: 'failure' };

  it('keeps only the last 200 lines and redacts secrets', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    lines[250] = 'token ghs_abcdefghijklmnopqrstuvwx';
    const section = logSection(job, lines.join('\n'));
    assert.match(section, /### Failing job: npm test/);
    assert.ok(!section.includes('line 50\n'));
    assert.match(section, /line 299/);
    assert.doesNotMatch(section, /ghs_abcdefghij/);
    assert.match(section, /ghs_\*\*\*/);
  });

  it('carries a failure from before the tail, with its expected and actual, and redacts a secret inside it', () => {
    const stamp = (line: string): string => `2026-11-02T10:15:30.1234567Z ${line}`;
    const failure = [
      '    not ok 1 - clean-room rejects a path outside the workspace',
      '      ---',
      "      error: 'token ghs_abcdefghijklmnopqrstuvwx'",
      "      expected: 'a'",
      "      actual: 'b'",
      '      ...',
    ];
    const passing = Array.from({ length: 400 }, (_, i) => `ok ${i + 1} - passes ${i + 1}`);
    const section = logSection(job, [...failure, ...passing].map(stamp).join('\n'));
    assert.match(section, /not ok 1 - clean-room rejects a path outside the workspace/);
    assert.match(section, /expected: 'a'/);
    assert.match(section, /actual: 'b'/);
    assert.match(section, /passes 400/);
    assert.doesNotMatch(section, /ghs_abcdefghij/);
    assert.doesNotMatch(section, /2026-11-02T/);
  });
});

describe('buildReworkFile', () => {
  const repo = { owner: 'JamieGeddes', name: 'factorial' };

  function clientWith(jobs: CheckJob[], logs: Map<number, string>): GitHubClient {
    return new GitHubClient({
      token: 'ghs_x',
      fetchImpl: (async (url: string | URL) => {
        const path = String(url);
        if (path.includes('/actions/runs?')) {
          return new Response(JSON.stringify({ workflow_runs: [{ id: 11 }] }), { status: 200 });
        }
        if (path.endsWith('/jobs?per_page=100')) {
          return new Response(JSON.stringify({ jobs }), { status: 200 });
        }
        const id = Number(path.match(/\/jobs\/(\d+)\/logs/)?.[1]);
        return new Response(logs.get(id) ?? '', { status: 200 });
      }) as typeof fetch,
    });
  }

  it('lists every review detail with its author, file and line, redacted', async () => {
    const { text: file } = await buildReworkFile(clientWith([], new Map()), repo, HEAD_SHA, rework, [
      { author: 'u', path: 'src/a.ts', line: 3, body: 'Fix this.\nSecret: ghs_abcdefghijklmnopqrstuvwx' },
    ]);
    assert.match(file, /# Rework of pull request #26/);
    assert.match(file, /Previous work item: 7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c/);
    assert.match(file, /Cause: review comments/);
    assert.match(file, /### Point 1: @u \(src\/a\.ts:3\)/);
    assert.match(file, /Fix this\./);
    assert.doesNotMatch(file, /ghs_abcdefghij/);
    assert.doesNotMatch(file, /## Failing checks/);
  });

  it('numbers the points in order, so the builder can answer each by number', async () => {
    const { text: file } = await buildReworkFile(clientWith([], new Map()), repo, HEAD_SHA, rework, rework.details);
    assert.match(file, /### Point 1: @JamieGeddes \(packages\/invoker\/src\/prompt\.ts:12\)\n\nPlease name/);
    assert.match(file, /### Point 2: @other-user\n\nOverall looks good\./);
  });

  it("adds a review's inline comments as further points, without bots, when the source names the review", async () => {
    const seen: string[] = [];
    const client = new GitHubClient({
      token: 'ghs_x',
      fetchImpl: (async (url: string | URL) => {
        seen.push(String(url));
        return new Response(
          JSON.stringify([
            { user: { login: 'JamieGeddes', type: 'User' }, path: 'src/b.ts', line: 4, original_line: 4, body: 'Inline one.' },
            { user: { login: 'helper[bot]', type: 'Bot' }, path: 'src/c.ts', line: 1, original_line: 1, body: 'Bot noise.' },
          ]),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    const { text, points } = await buildReworkFile(client, repo, HEAD_SHA, rework, rework.details, { sourceUrl: 'https://github.com/JamieGeddes/factorial/pull/26#pullrequestreview-77' });
    assert.deepEqual(seen, ['https://api.github.com/repos/JamieGeddes/factorial/pulls/26/reviews/77/comments?per_page=100']);
    assert.equal(points.length, 3);
    assert.match(text, /### Point 3: @JamieGeddes \(src\/b\.ts:4\)\n\nInline one\./);
    assert.doesNotMatch(text, /Bot noise/);
  });

  it("names the thread's opener as the previous work item", async () => {
    const { text } = await buildReworkFile(clientWith([], new Map()), repo, HEAD_SHA, { ...rework, previousWorkItemId: '11111111-2222-4333-8444-555555555555' }, rework.details);
    assert.match(text, /Previous work item: 11111111-2222-4333-8444-555555555555/);
  });

  it('describes a conversation request as such', async () => {
    const { text } = await buildReworkFile(clientWith([], new Map()), repo, HEAD_SHA, { ...rework, cause: 'comment' }, rework.details);
    assert.match(text, /Cause: a request made in the pull request's conversation/);
  });

  it('fetches no review comments when the source is a comment rather than a review', async () => {
    let called = false;
    const client = new GitHubClient({ token: 'ghs_x', fetchImpl: (async () => { called = true; return new Response('[]', { status: 200 }); }) as typeof fetch });
    const { points } = await buildReworkFile(client, repo, HEAD_SHA, rework, rework.details, { sourceUrl: 'https://github.com/JamieGeddes/factorial/pull/26#issuecomment-9' });
    assert.equal(called, false);
    assert.equal(points.length, 2);
  });

  it('does not fetch checks for a review-cause rework', async () => {
    let called = false;
    const client = new GitHubClient({
      token: 'ghs_x',
      fetchImpl: (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    await buildReworkFile(client, repo, HEAD_SHA, rework, rework.details);
    assert.equal(called, false);
  });

  it('includes the failing jobs and their logs for a checks-failed rework', async () => {
    const failing: CheckJob = { id: 4242, name: 'npm test', htmlUrl: 'https://github.com/JamieGeddes/factorial/job/4242', conclusion: 'failure' };
    const passing: CheckJob = { id: 4243, name: 'lint', htmlUrl: 'u', conclusion: 'success' };
    const logs = new Map([[4242, `old\n${Array.from({ length: 300 }, (_, i) => `l${i}`).join('\n')}\ntoken ghs_abcdefghijklmnopqrstuvwx`]]);
    const { text: file } = await buildReworkFile(clientWith([failing, passing], logs), repo, HEAD_SHA, { ...rework, cause: 'checks-failed' }, []);
    assert.match(file, /Cause: failed checks/);
    assert.match(file, /## Failing checks/);
    assert.match(file, /### Failing job: npm test/);
    assert.ok(!file.includes('### Failing job: lint'));
    assert.ok(!file.includes('l50\n'));
    assert.match(file, /l299/);
    assert.doesNotMatch(file, /ghs_abcdefghij/);
    assert.match(file, /_No specific points were recorded/);
  });

  it('keeps several failing jobs within the size limit and names each', async () => {
    const jobs: CheckJob[] = [1, 2, 3, 4].map((id) => ({ id, name: `job ${id}`, htmlUrl: `https://example.test/${id}`, conclusion: 'failure' }));
    const log = [
      ...Array.from({ length: 400 }, (_, i) => `    not ok ${i} - failing test number ${i}\n      ---\n      expected: ${'x'.repeat(200)}\n      actual: ${'y'.repeat(200)}\n      ...`),
      ...Array.from({ length: 300 }, (_, i) => `ok ${i} - passes`),
    ].join('\n');
    const logs = new Map(jobs.map((job) => [job.id, log]));
    const { text } = await buildReworkFile(clientWith(jobs, logs), repo, HEAD_SHA, { ...rework, cause: 'checks-failed' }, []);
    assert.ok(Buffer.byteLength(text) <= MAX_REWORK_BYTES, `${Buffer.byteLength(text)} bytes`);
    for (const job of jobs) assert.match(text, new RegExp(`### Failing job: ${job.name} `));
    assert.match(text, /failures before the tail were dropped to fit the size limit/);
    assert.match(text, /not ok 0 - failing test number 0/);
  });

  it('says so when no job is failing on the branch head any more', async () => {
    const { text: file } = await buildReworkFile(clientWith([], new Map()), repo, HEAD_SHA, { ...rework, cause: 'checks-failed' }, []);
    assert.match(file, /no longer reported as failing/);
  });
});

describe('detailsFor', () => {
  const repo = { owner: 'JamieGeddes', name: 'factorial' };
  const base: WorkItem = {
    schemaVersion: 1,
    id: '3e9b1f4a-2c6d-4e8f-9a0b-1c2d3e4f5a6b',
    source: { type: 'github-pull-request-review-comment', id: '5', url: 'https://github.com/JamieGeddes/factorial/pull/26#discussion_r5' },
    repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' },
    inReplyTo: { kind: 'pull-request', number: 26 },
    title: 'Comment on #26',
    body: 'Rename this.',
    requestedBy: 'alice',
    createdAt: '2026-10-27T09:00:00Z',
  };

  it("adds an inline comment's file and line, which the item does not carry", async () => {
    const seen: number[] = [];
    const client = { getReviewComment: async (_repo: unknown, id: number) => (seen.push(id), { path: 'src/a.ts', line: 3 }) };
    assert.deepEqual(await detailsFor(client, repo, base), [{ author: 'alice', path: 'src/a.ts', line: 3, body: 'Rename this.' }]);
    assert.deepEqual(seen, [5]);
  });

  it('fetches nothing for a conversation comment', async () => {
    const client = { getReviewComment: async () => assert.fail('fetched') };
    const comment = { ...base, source: { type: 'github-pull-request-comment', id: '9', url: 'https://github.com/JamieGeddes/factorial/pull/26#issuecomment-9' } };
    assert.deepEqual(await detailsFor(client, repo, comment), [{ author: 'alice', body: 'Rename this.' }]);
  });
});
