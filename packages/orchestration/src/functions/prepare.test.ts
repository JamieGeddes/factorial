import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ReworkContext, WorkItem } from '@factorial/workitem';
import { type CheckJob, GitHubClient } from '@factorial/github-app';

import { buildReworkFile, cloneScript, initialNotes, logSection } from './prepare.ts';

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

describe('cloneScript', () => {
  const params = {
    owner: 'JamieGeddes',
    name: 'factorial',
    branch: 'factorial/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
    token: TOKEN,
    workItemJson: '{"id":"x"}',
    notes: '# Task\n',
    mode: 'create' as const,
  };

  it('clones with the token as a header, never in the URL, then creates the branch', () => {
    const script = cloneScript(params);
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    assert.match(script, /^set -euo pipefail$/m);
    assert.match(script, /GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=\/dev\/null/);
    assert.match(script, new RegExp(`git -c http\\.extraHeader='AUTHORIZATION: basic ${basic}' clone --quiet 'https://github\\.com/JamieGeddes/factorial\\.git' /workspace/repo`));
    assert.doesNotMatch(script, /ghs_t/);
    assert.match(script, /git checkout --quiet -b 'factorial\/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c'/);
    assert.doesNotMatch(script, /--force/);
  });

  it('checks out the existing rework branch instead of creating one, and reports the head', () => {
    const script = cloneScript({ ...params, mode: 'checkout' });
    assert.match(script, /git checkout --quiet 'origin\/factorial\/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c'/);
    assert.match(script, /git branch --quiet 'factorial\/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c'/);
    assert.doesNotMatch(script, /checkout --quiet -b/);
    assert.match(script, /git rev-parse HEAD/);
    // the branch head comes before the default branch line, so the handler can tell them apart
    assert.ok(script.indexOf('git rev-parse HEAD') < script.indexOf('symbolic-ref'));
  });

  it('clears any stale rework.md from the workspace', () => {
    assert.match(cloneScript({ ...params, mode: 'checkout' }), /rm -rf .*\/workspace\/rework\.md/);
  });

  it('writes the WorkItem via base64 so no JSON reaches the shell unquoted', () => {
    const script = cloneScript(params);
    const encoded = Buffer.from(params.workItemJson).toString('base64');
    assert.match(script, new RegExp(`printf '%s' '${encoded}' \\| base64 -d > /workspace/workitem.json`));
    assert.doesNotMatch(script, /\{"id"/);
  });

  it('writes the initial notes via base64', () => {
    const encoded = Buffer.from(params.notes).toString('base64');
    assert.match(cloneScript(params), new RegExp(`printf '%s' '${encoded}' \\| base64 -d > /workspace/notes\\.md`));
  });

  it('rejects owner or repository names that are not plain GitHub names', () => {
    assert.throws(() => cloneScript({ ...params, owner: 'evil;rm -rf /' }), /not a valid GitHub name/);
    assert.throws(() => cloneScript({ ...params, name: "x'y" }), /not a valid GitHub name/);
  });

  it('rejects a rework branch that is not a plain branch name', () => {
    assert.throws(() => cloneScript({ ...params, branch: 'evil;rm', mode: 'checkout' }), /not a valid branch name/);
  });
});

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
    const notes = initialNotes(workItem, false);
    assert.match(notes, /^# Task\n/);
    assert.match(notes, /Source: https:\/\/github\.com\/JamieGeddes\/factorial\/issues\/7/);
    assert.match(notes, /## Fix typo\n\nThe word "recieve" should be "receive"\./);
    assert.ok(notes.indexOf('# Task') < notes.indexOf('# Plan'));
    assert.ok(notes.indexOf('# Plan') < notes.indexOf('# Notes'));
    assert.doesNotMatch(notes, /rework\.md/);
  });

  it('marks an empty body explicitly', () => {
    assert.match(initialNotes({ ...workItem, body: ' ' }, false), /_No further description was given\._/);
  });

  it('points rework items at rework.md', () => {
    assert.match(initialNotes(workItem, true), /every point in \/workspace\/rework\.md must be addressed/);
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
    const file = await buildReworkFile(clientWith([], new Map()), repo, HEAD_SHA, {
      ...rework,
      details: [{ author: 'u', path: 'src/a.ts', line: 3, body: 'Fix this.\nSecret: ghs_abcdefghijklmnopqrstuvwx' }],
    });
    assert.match(file, /# Rework of pull request #26/);
    assert.match(file, /Previous work item: 7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c/);
    assert.match(file, /Cause: review comments/);
    assert.match(file, /- \*\*@u \(src\/a\.ts:3\)\*\*/);
    assert.match(file, /Fix this\./);
    assert.doesNotMatch(file, /ghs_abcdefghij/);
    assert.doesNotMatch(file, /## Failing checks/);
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
    await buildReworkFile(client, repo, HEAD_SHA, rework);
    assert.equal(called, false);
  });

  it('includes the failing jobs and their logs for a checks-failed rework', async () => {
    const failing: CheckJob = { id: 4242, name: 'npm test', htmlUrl: 'https://github.com/JamieGeddes/factorial/job/4242', conclusion: 'failure' };
    const passing: CheckJob = { id: 4243, name: 'lint', htmlUrl: 'u', conclusion: 'success' };
    const logs = new Map([[4242, `old\n${Array.from({ length: 300 }, (_, i) => `l${i}`).join('\n')}\ntoken ghs_abcdefghijklmnopqrstuvwx`]]);
    const file = await buildReworkFile(clientWith([failing, passing], logs), repo, HEAD_SHA, {
      ...rework,
      cause: 'checks-failed',
      details: [],
    });
    assert.match(file, /Cause: failed checks/);
    assert.match(file, /## Failing checks/);
    assert.match(file, /### Failing job: npm test/);
    assert.ok(!file.includes('### Failing job: lint'));
    assert.ok(!file.includes('l50\n'));
    assert.match(file, /l299/);
    assert.doesNotMatch(file, /ghs_abcdefghij/);
    assert.match(file, /_No specific points were recorded/);
  });

  it('says so when no job is failing on the branch head any more', async () => {
    const file = await buildReworkFile(clientWith([], new Map()), repo, HEAD_SHA, { ...rework, cause: 'checks-failed', details: [] });
    assert.match(file, /no longer reported as failing/);
  });
});

describe('rework handling does not change new items', () => {
  it('a WorkItem without context still names a fresh factorial/<id> branch', async () => {
    const { workBranchFor } = await import('../lib/context.ts');
    const workItem: WorkItem = {
      schemaVersion: 1,
      id: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
      source: { type: 'github-issue', id: '7', url: 'https://github.com/JamieGeddes/factorial/issues/7' },
      repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' },
      title: 'T',
      body: '',
      requestedBy: 'JamieGeddes',
      createdAt: '2026-10-17T09:00:00Z',
    };
    assert.equal(workBranchFor(workItem), 'factorial/7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c');
    assert.equal(workBranchFor({ ...workItem, context: rework }), rework.branch);
  });
});
