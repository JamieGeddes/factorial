/**
 * Characterisation of what a session is seeded with (#166): the files placed
 * in /workspace and the sections added to the first message, for a new item,
 * a resumed item, a rework item, a later build round and the reviewer. The
 * fixtures under __snapshots__/seed were taken from the code before the
 * seed was assembled from providers, and must not change with a refactor: a
 * change here is a change in what a session is given. Regenerate on purpose
 * with UPDATE_SNAPSHOTS=1.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { GitHubClient } from '@factorial/github-app';
import type { WorkItem } from '@factorial/workitem';

import type { ReworkTurn } from './context.ts';
import { CONTINUE_PROVIDERS } from '../functions/continue-build.ts';
import { PREPARE_PROVIDERS } from '../functions/prepare.ts';
import { REVIEW_PROVIDERS } from '../functions/prepare-review.ts';
import { assembleSeed, type Seed, type SeedContext } from './seed.ts';
import type { SensitiveChange } from './review-files.ts';
import type { Attempt } from './resume.ts';

export interface SeedSnapshot {
  /** File name under /workspace to its content; a file made in the session from a command is `$ <command>`. */
  files: Record<string, string>;
  /** Section id to its text. */
  sections: Record<string, string>;
}

const repo = { owner: 'JamieGeddes', name: 'factorial' };
const HEAD = 'b'.repeat(40);

export const newItem: WorkItem = {
  schemaVersion: 1,
  id: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  source: { type: 'github-issue', id: '7', url: 'https://github.com/JamieGeddes/factorial/issues/7' },
  repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' },
  title: 'Fix typo',
  body: 'The word "recieve" should be "receive".\n\nAlso check the README.',
  requestedBy: 'JamieGeddes',
  createdAt: '2026-10-17T09:00:00Z',
};

export const reworkItem: WorkItem = {
  schemaVersion: 1,
  id: '3e9b1f4a-2c6d-4e8f-9a0b-1c2d3e4f5a6b',
  source: { type: 'github-pull-request-comment', id: '9', url: 'https://github.com/JamieGeddes/factorial/pull/26#issuecomment-9' },
  repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' },
  inReplyTo: { kind: 'pull-request', number: 26 },
  title: 'Comment on #26',
  body: 'Please rename the helper.\nToken: ghs_abcdefghijklmnopqrstuvwxyz0123456789',
  requestedBy: 'alice',
  createdAt: '2026-10-27T09:00:00Z',
};

export const reworkTurn: ReworkTurn = {
  pullRequest: { number: 26, url: 'https://github.com/JamieGeddes/factorial/pull/26' },
  cause: 'checks-failed',
  previousWorkItemId: '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c',
  baseBranch: 'main',
};

export const attempt: Attempt = { workItemId: '11111111-2222-4333-8444-555555555555', status: 'tests-failed' };

export const planJson = '{"schemaVersion":1,"steps":[{"id":"one"}]}';
export const planMarkdown = '# Plan\n\nDo one thing.\n';
export const summary = '## Summary\n\nDid the thing.\n';
export const previousNotes = '# Task\n\nthe request\n\n# Plan\n\n1. one: done\n\n# Notes\n\n- committed step one\n';
export const sensitive: SensitiveChange[] = [
  { path: '.github/workflows/ci.yml', reason: 'changes GitHub Actions' },
  { path: 'CODEOWNERS', reason: 'changes who must approve changes' },
];

const jobs = [
  { id: 5, name: 'Typecheck, test and lint', conclusion: 'failure', html_url: 'https://github.com/JamieGeddes/factorial/actions/runs/1/job/5' },
  { id: 6, name: 'Lint CloudFormation', conclusion: 'success', html_url: 'https://github.com/JamieGeddes/factorial/actions/runs/1/job/6' },
];

/** A GitHub client that serves one failing job with a log that holds a secret. */
export function fakeClient(): GitHubClient {
  return new GitHubClient({
    token: 'ghs_x',
    fetchImpl: (async (url: string | URL) => {
      const path = String(url);
      if (path.includes('/actions/runs?')) return new Response(JSON.stringify({ workflow_runs: [{ id: 11 }] }), { status: 200 });
      if (path.endsWith('/jobs?per_page=100')) return new Response(JSON.stringify({ jobs }), { status: 200 });
      if (path.includes('/jobs/5/logs')) return new Response('line 1\nFAIL src/a.test.ts\nsecret ghs_abcdefghijklmnopqrstuvwxyz0123456789\n', { status: 200 });
      return new Response('', { status: 200 });
    }) as typeof fetch,
  });
}

/** A context as the stages build it, over a clone with no repository instructions. */
export function contextFor(workItem: WorkItem, extra: Partial<SeedContext> = {}): SeedContext {
  return {
    role: 'builder',
    workItem,
    baseCommit: HEAD,
    baseBranch: 'main',
    round: 1,
    read: async () => 'missing:',
    github: async () => fakeClient(),
    ...extra,
  };
}

/** A seed as a snapshot: the content of each file, or for a file made in the session its command. */
export function snapshotOf(seed: Seed): SeedSnapshot {
  return {
    files: Object.fromEntries(seed.files.map((f) => [f.path, 'content' in f ? f.content : `$ cd /workspace/repo && ${f.command}`])),
    sections: Object.fromEntries(seed.sections.map((s) => [s.id, s.text])),
  };
}

/** The lists the stages seed with, over the same inputs the sessions were seeded from before. */
export const SCENARIOS: Record<string, () => Promise<SeedSnapshot>> = {
  'new-item': async () => snapshotOf(await assembleSeed(PREPARE_PROVIDERS, contextFor(newItem))),
  'resumed-item': async () => snapshotOf(await assembleSeed(PREPARE_PROVIDERS, contextFor(newItem, { resumedFrom: attempt }))),
  'rework-item': async () => snapshotOf(await assembleSeed(PREPARE_PROVIDERS, contextFor(reworkItem, { rework: reworkTurn }))),
  'later-round': async () =>
    snapshotOf(
      await assembleSeed(
        CONTINUE_PROVIDERS,
        contextFor(reworkItem, {
          rework: reworkTurn,
          round: 2,
          continuing: { baseCommit: HEAD, pushed: true, commitCount: 2 },
          previousNotes,
          plan: { json: planJson, markdown: planMarkdown },
        }),
      ),
    ),
  reviewer: async () =>
    snapshotOf(
      await assembleSeed(
        REVIEW_PROVIDERS,
        contextFor(reworkItem, { role: 'reviewer', rework: reworkTurn, plan: { json: planJson, markdown: planMarkdown }, summary, sensitive }),
      ),
    ),
};

const fixture = (name: string): string => new URL(`./__snapshots__/seed/${name}.json`, import.meta.url).pathname;

/** Compare a seed with the committed fixture, or write the fixture when asked to. */
export function expectSnapshot(name: string, actual: SeedSnapshot): void {
  const sorted: SeedSnapshot = {
    files: Object.fromEntries(Object.entries(actual.files).sort(([a], [b]) => a.localeCompare(b))),
    sections: Object.fromEntries(Object.entries(actual.sections).sort(([a], [b]) => a.localeCompare(b))),
  };
  const text = `${JSON.stringify(sorted, null, 2)}\n`;
  if (process.env.UPDATE_SNAPSHOTS === '1' || !existsSync(fixture(name))) {
    if (process.env.CI) assert.fail(`snapshot ${name} is missing`);
    writeFileSync(fixture(name), text);
  }
  assert.equal(text, readFileSync(fixture(name), 'utf8'), `seed snapshot ${name} changed`);
}

describe('what a session is seeded with', () => {
  for (const [name, seed] of Object.entries(SCENARIOS)) {
    it(`${name} matches its snapshot`, async () => {
      expectSnapshot(name, await seed());
    });
  }
});
