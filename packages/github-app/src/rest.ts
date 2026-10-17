/**
 * The handful of GitHub REST calls the orchestrator makes, with an installation
 * token. Dependency-free; errors carry the status and GitHub's message.
 */
export interface GitHubClientOptions {
  token: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number, body: string) {
    super(`GitHub ${method} ${path} failed: ${status} ${body}`);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

export interface Repo {
  owner: string;
  name: string;
}

export interface PullRequest {
  number: number;
  htmlUrl: string;
}

/** A job in a GitHub Actions run, as far as Factorial is concerned. */
export interface CheckJob {
  id: number;
  name: string;
  htmlUrl: string;
  /** `failure` for the jobs that failed; `null` while still running. */
  conclusion: string | null;
}

export class GitHubClient {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(options: GitHubClientOptions) {
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#baseUrl = options.baseUrl ?? 'https://api.github.com';
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.#token}`,
        'content-type': 'application/json',
        'user-agent': 'factorial',
        'x-github-api-version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new GitHubApiError(method, path, response.status, await response.text());
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  /** Start a workflow_dispatch run. GitHub returns no run id; the run reports back itself. */
  async dispatchWorkflow(repo: Repo, workflowFile: string, ref: string, inputs: Record<string, string>): Promise<void> {
    await this.#request<void>(
      'POST',
      `/repos/${repo.owner}/${repo.name}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
      { ref, inputs },
    );
  }

  async createPullRequest(
    repo: Repo,
    params: { title: string; body: string; head: string; base: string },
  ): Promise<PullRequest> {
    const created = await this.#request<{ number: number; html_url: string }>(
      'POST',
      `/repos/${repo.owner}/${repo.name}/pulls`,
      params,
    );
    return { number: created.number, htmlUrl: created.html_url };
  }

  async commentOnIssue(repo: Repo, issueNumber: number, body: string): Promise<void> {
    await this.#request<unknown>('POST', `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments`, { body });
  }

  async getDefaultBranch(repo: Repo): Promise<string> {
    const info = await this.#request<{ default_branch: string }>('GET', `/repos/${repo.owner}/${repo.name}`);
    return info.default_branch;
  }

  /** A user or bot account by login, e.g. `my-app[bot]`. */
  async getUser(login: string): Promise<{ id: number; login: string; type: string }> {
    const user = await this.#request<{ id: number; login: string; type: string }>('GET', `/users/${encodeURIComponent(login)}`);
    return { id: user.id, login: user.login, type: user.type };
  }

  /** A job from the Actions API, trimmed to the fields Factorial uses. */
  async #listJobs(repo: Repo, path: string): Promise<CheckJob[]> {
    const page = await this.#request<{
      jobs?: Array<{ id: number; name: string; html_url: string; conclusion: string | null }>;
    }>('GET', path);
    return (page.jobs ?? []).map((job) => ({ id: job.id, name: job.name, htmlUrl: job.html_url, conclusion: job.conclusion }));
  }

  /** The jobs that ran for a commit, across every workflow run on it. */
  async listJobsForHeadSha(repo: Repo, sha: string): Promise<CheckJob[]> {
    const runs = await this.#request<{ workflow_runs?: Array<{ id: number }> }>(
      'GET',
      `/repos/${repo.owner}/${repo.name}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`,
    );
    const jobs: CheckJob[] = [];
    for (const run of runs.workflow_runs ?? []) {
      jobs.push(...(await this.#listJobs(repo, `/repos/${repo.owner}/${repo.name}/actions/runs/${run.id}/jobs?per_page=100`)));
    }
    return jobs;
  }

  /**
   * A job's log. GitHub answers with a redirect to a short-lived signed URL;
   * fetch follows it and, per the fetch specification, drops the Authorization
   * header on the cross-origin hop, so the token never reaches the blob store.
   */
  async getJobLog(repo: Repo, jobId: number): Promise<string> {
    const response = await this.#fetch(`${this.#baseUrl}/repos/${repo.owner}/${repo.name}/actions/jobs/${jobId}/logs`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${this.#token}`,
        'user-agent': 'factorial',
        'x-github-api-version': '2022-11-28',
      },
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new GitHubApiError('GET', `/repos/${repo.owner}/${repo.name}/actions/jobs/${jobId}/logs`, response.status, await response.text());
    }
    return response.text();
  }

  /** The commit a branch currently points at. */
  async getBranchSha(repo: Repo, branch: string): Promise<string> {
    const ref = await this.#request<{ object: { sha: string } }>(
      'GET',
      `/repos/${repo.owner}/${repo.name}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,
    );
    return ref.object.sha;
  }
}
