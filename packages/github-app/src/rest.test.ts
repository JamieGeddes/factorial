import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GitHubApiError, GitHubClient } from './rest.ts';

interface Seen {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(status: number, responseBody: unknown, seen: Seen[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method,
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const text = responseBody === undefined ? '' : JSON.stringify(responseBody);
    return new Response(status === 204 ? null : text, { status });
  }) as typeof fetch;
}

const repo = { owner: 'JamieGeddes', name: 'factorial' };

describe('GitHubClient', () => {
  it('dispatches a workflow with ref and inputs and sends the token', async () => {
    const seen: Seen[] = [];
    const client = new GitHubClient({ token: 'ghs_x', fetchImpl: fakeFetch(204, undefined, seen) });
    await client.dispatchWorkflow(repo, 'test.yml', 'factorial/abc', { task_token: 'tok' });
    assert.equal(seen[0]?.url, 'https://api.github.com/repos/JamieGeddes/factorial/actions/workflows/test.yml/dispatches');
    assert.equal(seen[0]?.method, 'POST');
    assert.equal(seen[0]?.headers.authorization, 'Bearer ghs_x');
    assert.deepEqual(seen[0]?.body, { ref: 'factorial/abc', inputs: { task_token: 'tok' } });
  });

  it('creates a pull request and returns its number and URL', async () => {
    const seen: Seen[] = [];
    const client = new GitHubClient({
      token: 't',
      fetchImpl: fakeFetch(201, { number: 12, html_url: 'https://github.com/JamieGeddes/factorial/pull/12' }, seen),
    });
    const pr = await client.createPullRequest(repo, { title: 'T', body: 'B', head: 'factorial/abc', base: 'main' });
    assert.deepEqual(pr, { number: 12, htmlUrl: 'https://github.com/JamieGeddes/factorial/pull/12' });
    assert.deepEqual(seen[0]?.body, { title: 'T', body: 'B', head: 'factorial/abc', base: 'main' });
  });

  it('comments on an issue', async () => {
    const seen: Seen[] = [];
    const client = new GitHubClient({ token: 't', fetchImpl: fakeFetch(201, { id: 1 }, seen) });
    await client.commentOnIssue(repo, 7, 'hello');
    assert.equal(seen[0]?.url, 'https://api.github.com/repos/JamieGeddes/factorial/issues/7/comments');
    assert.deepEqual(seen[0]?.body, { body: 'hello' });
  });

  it('reacts to an issue', async () => {
    const seen: Seen[] = [];
    const client = new GitHubClient({ token: 't', fetchImpl: fakeFetch(201, { id: 1 }, seen) });
    await client.addIssueReaction(repo, 7, 'eyes');
    assert.equal(seen[0]?.url, 'https://api.github.com/repos/JamieGeddes/factorial/issues/7/reactions');
    assert.equal(seen[0]?.method, 'POST');
    assert.deepEqual(seen[0]?.body, { content: 'eyes' });
  });

  it('requests reviewers on a pull request', async () => {
    const seen: Seen[] = [];
    const client = new GitHubClient({ token: 't', fetchImpl: fakeFetch(201, { number: 26 }, seen) });
    await client.requestReviewers(repo, 26, ['alice', 'bob']);
    assert.equal(seen[0]?.url, 'https://api.github.com/repos/JamieGeddes/factorial/pulls/26/requested_reviewers');
    assert.equal(seen[0]?.method, 'POST');
    assert.deepEqual(seen[0]?.body, { reviewers: ['alice', 'bob'] });
  });

  it('reads a pull request trimmed to its state, author and branches', async () => {
    const seen: Seen[] = [];
    const client = new GitHubClient({
      token: 't',
      fetchImpl: fakeFetch(
        200,
        { number: 26, state: 'open', user: { login: 'x[bot]' }, head: { ref: 'factorial/a', sha: 'c'.repeat(40), repo: null }, base: { ref: 'main', repo: { id: 42 } } },
        seen,
      ),
    });
    assert.deepEqual(await client.getPullRequest(repo, 26), {
      number: 26,
      state: 'open',
      authorLogin: 'x[bot]',
      headRef: 'factorial/a',
      headSha: 'c'.repeat(40),
      headRepoId: undefined,
      baseRef: 'main',
      baseRepoId: 42,
    });
    assert.equal(seen[0]?.url, 'https://api.github.com/repos/JamieGeddes/factorial/pulls/26');
  });

  it("lists one review's inline comments, falling back to the original line", async () => {
    const seen: Seen[] = [];
    const client = new GitHubClient({
      token: 't',
      fetchImpl: fakeFetch(
        200,
        [
          { user: { login: 'alice', type: 'User' }, path: 'a.ts', line: 3, original_line: 2, body: 'one' },
          { user: null, path: 'b.ts', line: null, original_line: 7, body: 'two' },
        ],
        seen,
      ),
    });
    assert.deepEqual(await client.listReviewComments(repo, 26, 77), [
      { authorLogin: 'alice', authorType: 'User', path: 'a.ts', line: 3, body: 'one' },
      { authorLogin: 'ghost', authorType: 'User', path: 'b.ts', line: 7, body: 'two' },
    ]);
    assert.equal(seen[0]?.url, 'https://api.github.com/repos/JamieGeddes/factorial/pulls/26/reviews/77/comments?per_page=100');
  });

  it("reads the state of an inline comment's review in two calls", async () => {
    const seen: string[] = [];
    const client = new GitHubClient({
      token: 't',
      fetchImpl: (async (url: string | URL) => {
        seen.push(String(url));
        const body = String(url).includes('/pulls/comments/') ? { pull_request_review_id: 77 } : { state: 'CHANGES_REQUESTED' };
        return new Response(JSON.stringify(body), { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(await client.reviewStateOfComment(repo, 26, 5), 'CHANGES_REQUESTED');
    assert.deepEqual(seen, [
      'https://api.github.com/repos/JamieGeddes/factorial/pulls/comments/5',
      'https://api.github.com/repos/JamieGeddes/factorial/pulls/26/reviews/77',
    ]);
  });

  it("reads an inline comment's file and line, falling back to the original line", async () => {
    const seen: Seen[] = [];
    const client = new GitHubClient({ token: 't', fetchImpl: fakeFetch(200, { path: 'a.ts', line: null, original_line: 7, body: 'x' }, seen) });
    assert.deepEqual(await client.getReviewComment(repo, 5), { path: 'a.ts', line: 7 });
    assert.equal(seen[0]?.url, 'https://api.github.com/repos/JamieGeddes/factorial/pulls/comments/5');
  });

  it('reacts to a conversation comment and to an inline comment at their own endpoints', async () => {
    const seen: Seen[] = [];
    const client = new GitHubClient({ token: 't', fetchImpl: fakeFetch(201, { id: 1 }, seen) });
    await client.addReaction(repo, { kind: 'conversation', id: 9 }, 'eyes');
    await client.addReaction(repo, { kind: 'inline', id: 5 }, 'eyes');
    assert.equal(seen[0]?.url, 'https://api.github.com/repos/JamieGeddes/factorial/issues/comments/9/reactions');
    assert.equal(seen[1]?.url, 'https://api.github.com/repos/JamieGeddes/factorial/pulls/comments/5/reactions');
    assert.deepEqual(seen[0]?.body, { content: 'eyes' });
  });

  it('reads a branch head through the git refs API', async () => {
    const seen: Seen[] = [];
    const client = new GitHubClient({ token: 't', fetchImpl: fakeFetch(200, { object: { sha: 'b'.repeat(40) } }, seen) });
    assert.equal(await client.getBranchSha(repo, 'factorial/abc'), 'b'.repeat(40));
    assert.equal(seen[0]?.url, 'https://api.github.com/repos/JamieGeddes/factorial/git/ref/heads/factorial/abc');
  });

  it('throws a GitHubApiError carrying the status on failure', async () => {
    const client = new GitHubClient({ token: 't', fetchImpl: fakeFetch(422, { message: 'Validation Failed' }, []) });
    await assert.rejects(
      client.createPullRequest(repo, { title: 'T', body: 'B', head: 'h', base: 'main' }),
      (error: unknown) => error instanceof GitHubApiError && error.status === 422 && /Validation Failed/.test(error.message),
    );
  });
});

describe('getUser', () => {
  it('looks a login up and returns its id and type', async () => {
    const seen: Seen[] = [];
    const client = new GitHubClient({ token: 'ghs_x', fetchImpl: fakeFetch(200, { id: 7, login: 'factorial-x[bot]', type: 'Bot' }, seen) });
    const user = await client.getUser('factorial-x[bot]');
    assert.deepEqual(user, { id: 7, login: 'factorial-x[bot]', type: 'Bot' });
    assert.equal(seen[0]?.url, 'https://api.github.com/users/factorial-x%5Bbot%5D');
  });
});

describe('Actions checks and logs', () => {
  const job = { id: 4242, name: 'npm test', html_url: 'https://github.com/JamieGeddes/factorial/job/4242', conclusion: 'failure' };

  it('lists the jobs of every run for a head sha', async () => {
    const pages: Array<{ status: number; body: unknown }> = [
      { status: 200, body: { workflow_runs: [{ id: 11 }, { id: 12 }] } },
      { status: 200, body: { jobs: [job] } },
      { status: 200, body: { jobs: [{ id: 4243, name: 'lint', html_url: 'u', conclusion: 'success' }] } },
    ];
    const seen: Seen[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(_url), method: init?.method, headers: (init?.headers as Record<string, string>) ?? {}, body: undefined });
      const page = pages.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(page.body), { status: page.status });
    }) as typeof fetch;
    const client = new GitHubClient({ token: 'ghs_x', fetchImpl });
    const jobs = await client.listJobsForHeadSha(repo, 'a'.repeat(40));
    assert.deepEqual(jobs, [{ id: 4242, name: 'npm test', htmlUrl: 'https://github.com/JamieGeddes/factorial/job/4242', conclusion: 'failure' }, { id: 4243, name: 'lint', htmlUrl: 'u', conclusion: 'success' }]);
    assert.equal(seen[0]?.url, 'https://api.github.com/repos/JamieGeddes/factorial/actions/runs?head_sha=' + 'a'.repeat(40) + '&per_page=100');
  });

  it('fetches a job log without JSON-encoding it', async () => {
    const seen: Seen[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method, headers: (init?.headers as Record<string, string>) ?? {}, body: undefined });
      return new Response('npm ERR! code ELIFECYCLE\n', { status: 200 });
    }) as typeof fetch;
    const client = new GitHubClient({ token: 'ghs_x', fetchImpl });
    const log = await client.getJobLog(repo, 4242);
    assert.equal(log, 'npm ERR! code ELIFECYCLE\n');
    assert.equal(seen[0]?.url, 'https://api.github.com/repos/JamieGeddes/factorial/actions/jobs/4242/logs');
    assert.equal(seen[0]?.headers.authorization, 'Bearer ghs_x');
  });

  it('throws a GitHubApiError when a log cannot be fetched', async () => {
    const client = new GitHubClient({ token: 'ghs_x', fetchImpl: fakeFetch(410, { message: 'Gone' }, []) });
    await assert.rejects(
      client.getJobLog(repo, 4242),
      (error: unknown) => error instanceof GitHubApiError && error.status === 410,
    );
  });
});
