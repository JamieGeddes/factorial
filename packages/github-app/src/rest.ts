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
}
