/**
 * Tests for the rework adapter's guards that need lookups: the ledger
 * fail-closed rule (no WorkItem for the PR, or the checks-failed cap) and the
 * GitHub enrichments. GitHubFetch is constructed directly with a fake fetch,
 * and the ledger is injected, so nothing reaches AWS.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateWorkItem } from '@factorial/workitem';

import { buildRework, GitHubFetch } from './enrich.ts';
import type { LedgerRow } from './ledger.ts';
import type { PullRequestRef, RepositoryRef } from './payloads.ts';

const repository: RepositoryRef = { name: 'factorial', owner: { login: 'JamieGeddes' } };
const botLogin = 'my-factorial[bot]';
const pullRequest: PullRequestRef = {
  number: 7,
  html_url: 'https://github.com/JamieGeddes/factorial/pull/7',
  head: { ref: 'factorial/146b11c0', sha: 'a'.repeat(40) },
  base: { ref: 'main' },
  user: { login: 'my-factorial[bot]', type: 'Bot' },
};
const previousWorkItemId = '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c';
const options = { deliveryId: '2f9a6b3e-7c1d-4e5f-8a9b-0c1d2e3f4a5b', baseBranch: 'main', botLogin };

const rows = (...items: LedgerRow[]) => items;

/** A GitHubFetch whose every call answers from a fixed list of responses. */
function fakeGitHub(responses: Record<string, unknown>): GitHubFetch {
  return new GitHubFetch(
    'token',
    (async (url: string | URL | Request) => {
      for (const [path, body] of Object.entries(responses)) {
        if (String(url).endsWith(path)) {
          return new Response(JSON.stringify(body), { status: 200 });
        }
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
  );
}

describe('buildRework guards', () => {
  const checksFailedDecision = {
    kind: 'rework-checks-failed',
    pullRequest,
    headSha: 'a'.repeat(40),
  } as const;

  it('fails closed when the ledger has no WorkItem for the PR', async () => {
    const outcome = await buildRework(checksFailedDecision, repository, fakeGitHub({}), options, async () => rows());
    assert.deepEqual(outcome, { kind: 'ignore', reason: 'no WorkItem recorded for this pull request' });
  });

  it('ignores a third automatic checks-failed rework', async () => {
    const outcome = await buildRework(
      checksFailedDecision,
      repository,
      fakeGitHub({}),
      options,
      async () => rows({ workItemId: '2', cause: 'checks-failed' }, { workItemId: '1', cause: 'checks-failed' }),
    );
    assert.deepEqual(outcome, {
      kind: 'ignore',
      reason: 'already 2 automatic checks-failed reworks without a human comment',
    });
  });

  it('builds a checks-failed WorkItem from the failing check-runs, without fetching logs', async () => {
    const seen: string[] = [];
    const github = new GitHubFetch(
      'token',
      (async (url: string | URL | Request) => {
        seen.push(String(url));
        if (String(url).endsWith(`/commits/${'a'.repeat(40)}/check-runs?per_page=100`)) {
          return new Response(
            JSON.stringify({
              check_runs: [
                { name: 'Typecheck, test and lint', html_url: 'https://github.com/x/actions/runs/1/job/1', conclusion: 'failure' },
                { name: 'Lint CloudFormation', html_url: 'https://github.com/x/actions/runs/1/job/2', conclusion: 'success' },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch,
    );
    const outcome = await buildRework(
      checksFailedDecision,
      repository,
      github,
      options,
      async () => rows({ workItemId: '5f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c', cause: 'review' }, { workItemId: previousWorkItemId }),
    );
    assert.ok(!('kind' in outcome));
    if ('kind' in outcome) return;
    assert.equal(validateWorkItem(outcome).ok, true);
    assert.equal(outcome.context?.cause, 'checks-failed');
    assert.equal(outcome.context?.details.length, 1);
    assert.equal(outcome.context?.details[0]?.body.includes('Typecheck, test and lint'), true);
    assert.equal(outcome.requestedBy, botLogin);
    // Only the check-runs endpoint is called: no logs endpoint here.
    assert.equal(seen.length, 1);
    assert.match(seen[0]!, /\/check-runs\?/);
  });

  it('builds a review rework WorkItem with the PR review comments as details', async () => {
    const decision = { kind: 'rework-review', pullRequest, comment: { author: 'JamieGeddes', body: '/factorial rework it' } } as const;
    const github = fakeGitHub({
      '/pulls/7/comments?per_page=100': [
        { user: { login: 'reviewer' }, body: 'Inline point.', path: 'src/x.ts', line: 3 },
        { user: { login: 'other' }, body: 'Another point.' },
      ],
    });
    const outcome = await buildRework(decision, repository, github, options, async () => rows({ workItemId: previousWorkItemId }));
    assert.ok(!('kind' in outcome));
    if ('kind' in outcome) return;
    assert.equal(validateWorkItem(outcome).ok, true);
    assert.equal(outcome.context?.cause, 'review');
    assert.deepEqual(outcome.context?.details, [
      { author: 'reviewer', body: 'Inline point.', path: 'src/x.ts', line: 3 },
      { author: 'other', body: 'Another point.' },
      { author: 'JamieGeddes', body: '/factorial rework it' },
    ]);
    assert.equal(outcome.body, '/factorial rework it');
  });

  it('does not duplicate the triggering review comment when the API already returns it', async () => {
    const triggered = { author: 'reviewer', body: 'Inline point.', path: 'src/x.ts', line: 3 };
    const decision = { kind: 'rework-review', pullRequest, comment: triggered } as const;
    const github = fakeGitHub({
      '/pulls/7/comments?per_page=100': [{ user: { login: 'reviewer' }, body: 'Inline point.', path: 'src/x.ts', line: 3 }],
    });
    const outcome = await buildRework(decision, repository, github, options, async () => rows({ workItemId: previousWorkItemId }));
    assert.ok(!('kind' in outcome));
    if ('kind' in outcome) return;
    assert.deepEqual(outcome.context?.details, [triggered]);
  });
});

describe('GitHubFetch', () => {
  it('sends the token and reads a pull request', async () => {
    let seen: { url: string; authorization: string } | undefined;
    const github = new GitHubFetch(
      'tok',
      (async (url: string | URL | Request, init?: RequestInit) => {
        seen = { url: String(url), authorization: (init?.headers as Record<string, string>).authorization! };
        return new Response(
          JSON.stringify({
            number: 7,
            html_url: pullRequest.html_url,
            head: { ref: 'factorial/146b11c0', sha: 'a'.repeat(40) },
            base: { ref: 'main' },
            user: { login: 'my-factorial[bot]', type: 'Bot' },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    );
    const pr = await github.getPullRequest(repository, 7);
    assert.equal(pr.number, pullRequest.number);
    assert.equal(pr.html_url, pullRequest.html_url);
    assert.deepEqual(pr.head, pullRequest.head);
    assert.deepEqual(pr.base, pullRequest.base);
    assert.equal(pr.user.login, pullRequest.user.login);
    assert.equal(pr.user.type, pullRequest.user.type);
    assert.equal(seen?.url, 'https://api.github.com/repos/JamieGeddes/factorial/pulls/7');
    assert.equal(seen?.authorization, 'Bearer tok');
  });
});
