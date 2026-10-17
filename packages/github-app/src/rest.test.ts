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
