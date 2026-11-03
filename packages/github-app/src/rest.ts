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

/** A pull request's state, as far as checking it before rework is concerned. */
export interface PullRequestState {
  number: number;
  state: string;
  authorLogin: string;
  headRef: string;
  headSha: string;
  /** Undefined when the head repository has been deleted. */
  headRepoId: number | undefined;
  baseRef: string;
  baseRepoId: number;
}

/** An issue, trimmed to what a turn on it needs: the request it holds and whether it is still open. */
export interface IssueState {
  number: number;
  state: string;
  title: string;
  /** Empty when the issue has no description. */
  body: string;
  htmlUrl: string;
  author: { id: number; login: string };
  /** GitHub serves pull requests through the issues API too; this says which it is. */
  isPullRequest: boolean;
}

/** Whether and how a pull request closed: the facts a PullRequestClosed event carries. */
export interface PullRequestClose {
  number: number;
  htmlUrl: string;
  /** `open` or `closed`. */
  state: string;
  headRef: string;
  merged: boolean;
  closedAt: string | undefined;
  mergedAt: string | undefined;
  /** When merged: the commit the merge made on the base branch. */
  mergeCommit: string | undefined;
  /** When merged: who merged it; undefined when that account no longer exists. */
  mergedBy: string | undefined;
}

/** An inline comment on a pull request's diff. */
export interface ReviewComment {
  authorLogin: string;
  authorType: string;
  path: string;
  /** The line in the current diff, or the original line when the comment is outdated; undefined for a file-level comment. */
  line: number | undefined;
  body: string;
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

  async getPullRequest(repo: Repo, pullNumber: number): Promise<PullRequestState> {
    const pr = await this.#request<{
      number: number;
      state: string;
      user: { login: string };
      head: { ref: string; sha: string; repo: { id: number } | null };
      base: { ref: string; repo: { id: number } };
    }>('GET', `/repos/${repo.owner}/${repo.name}/pulls/${pullNumber}`);
    return {
      number: pr.number,
      state: pr.state,
      authorLogin: pr.user.login,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      headRepoId: pr.head.repo?.id,
      baseRef: pr.base.ref,
      baseRepoId: pr.base.repo.id,
    };
  }

  /** An issue's request and state. A pull request read here says so (`isPullRequest`). */
  async getIssue(repo: Repo, issueNumber: number): Promise<IssueState> {
    const issue = await this.#request<{
      number: number;
      state: string;
      title: string;
      body: string | null;
      html_url: string;
      user: { id: number; login: string };
      pull_request?: unknown;
    }>('GET', `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`);
    return {
      number: issue.number,
      state: issue.state,
      title: issue.title,
      body: issue.body ?? '',
      htmlUrl: issue.html_url,
      author: { id: issue.user.id, login: issue.user.login },
      isPullRequest: issue.pull_request !== undefined && issue.pull_request !== null,
    };
  }

  /** Whether a pull request has closed and, if it has, when, whether merged and by whom. */
  async getPullRequestClose(repo: Repo, pullNumber: number): Promise<PullRequestClose> {
    const pr = await this.#request<{
      number: number;
      html_url: string;
      state: string;
      head: { ref: string };
      merged?: boolean;
      closed_at: string | null;
      merged_at: string | null;
      merge_commit_sha: string | null;
      merged_by?: { login: string } | null;
    }>('GET', `/repos/${repo.owner}/${repo.name}/pulls/${pullNumber}`);
    const merged = pr.merged === true || pr.merged_at !== null;
    return {
      number: pr.number,
      htmlUrl: pr.html_url,
      state: pr.state,
      headRef: pr.head.ref,
      merged,
      closedAt: pr.closed_at ?? undefined,
      mergedAt: pr.merged_at ?? undefined,
      mergeCommit: merged ? (pr.merge_commit_sha ?? undefined) : undefined,
      mergedBy: pr.merged_by?.login,
    };
  }

  /**
   * Who closed an issue or pull request, from the issues API: the pulls API
   * names only who merged. Undefined while open, or when that account no
   * longer exists.
   */
  async closedBy(repo: Repo, issueNumber: number): Promise<string | undefined> {
    const issue = await this.#request<{ closed_by?: { login: string } | null }>('GET', `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`);
    return issue.closed_by?.login;
  }

  /**
   * The state of the review an inline comment was submitted with
   * (`CHANGES_REQUESTED`, `COMMENTED`, …), or undefined for a comment that
   * belongs to none.
   */
  async reviewStateOfComment(repo: Repo, pullNumber: number, commentId: number): Promise<string | undefined> {
    const comment = await this.#request<{ pull_request_review_id: number | null }>('GET', `/repos/${repo.owner}/${repo.name}/pulls/comments/${commentId}`);
    if (comment.pull_request_review_id === null) return undefined;
    const review = await this.#request<{ state: string }>('GET', `/repos/${repo.owner}/${repo.name}/pulls/${pullNumber}/reviews/${comment.pull_request_review_id}`);
    return review.state;
  }

  /** An inline comment's file and line: the line in the current diff, or where it was made when that line is gone. */
  async getReviewComment(repo: Repo, commentId: number): Promise<{ path: string; line: number | undefined }> {
    const comment = await this.#request<{ path: string; line: number | null; original_line: number | null }>('GET', `/repos/${repo.owner}/${repo.name}/pulls/comments/${commentId}`);
    return { path: comment.path, line: comment.line ?? comment.original_line ?? undefined };
  }

  /** React to a comment in a pull request's conversation (`conversation`) or inline on its diff (`inline`). */
  async addReaction(repo: Repo, comment: { kind: 'conversation' | 'inline'; id: number }, content: '+1' | 'eyes' | 'rocket'): Promise<void> {
    const kind = comment.kind === 'conversation' ? 'issues' : 'pulls';
    await this.#request<unknown>('POST', `/repos/${repo.owner}/${repo.name}/${kind}/comments/${comment.id}/reactions`, { content });
  }

  /** React to an issue (or pull request) itself, not to a comment on it. */
  async addIssueReaction(repo: Repo, issueNumber: number, content: '+1' | 'eyes' | 'rocket'): Promise<void> {
    await this.#request<unknown>('POST', `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/reactions`, { content });
  }

  /**
   * The conversation comments on an issue or pull request, oldest first,
   * updated at or after `since` when given, at most `maxPages` pages of 100.
   */
  async listIssueComments(
    repo: Repo,
    issueNumber: number,
    options: { since?: string; maxPages?: number } = {},
  ): Promise<Array<{ authorLogin: string; body: string }>> {
    const maxPages = options.maxPages ?? 10;
    const since = options.since ? `&since=${encodeURIComponent(options.since)}` : '';
    const all: Array<{ authorLogin: string; body: string }> = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const comments = await this.#request<Array<{ user: { login: string } | null; body?: string | null }>>(
        'GET',
        `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}/comments?per_page=100&page=${page}${since}`,
      );
      all.push(...comments.map((c) => ({ authorLogin: c.user?.login ?? 'ghost', body: c.body ?? '' })));
      if (comments.length < 100) break;
    }
    return all;
  }

  /** The inline comments submitted with one review, at most 100. */
  async listReviewComments(repo: Repo, pullNumber: number, reviewId: number): Promise<ReviewComment[]> {
    const comments = await this.#request<
      Array<{ user: { login: string; type: string } | null; path: string; line: number | null; original_line: number | null; body: string }>
    >('GET', `/repos/${repo.owner}/${repo.name}/pulls/${pullNumber}/reviews/${reviewId}/comments?per_page=100`);
    return comments.map((c) => ({
      authorLogin: c.user?.login ?? 'ghost',
      authorType: c.user?.type ?? 'User',
      path: c.path,
      line: c.line ?? c.original_line ?? undefined,
      body: c.body,
    }));
  }

  /**
   * Ask these users to review a pull request. A user who has already reviewed
   * it is asked again, which is how GitHub re-requests a review.
   */
  async requestReviewers(repo: Repo, pullNumber: number, reviewers: readonly string[]): Promise<void> {
    await this.#request<unknown>('POST', `/repos/${repo.owner}/${repo.name}/pulls/${pullNumber}/requested_reviewers`, { reviewers });
  }

  /**
   * The text of the file at `path` on `ref`, through the contents API (needs
   * `contents: read`), or undefined when the file or the ref is not there.
   * A file over `maxBytes` (the API serves at most 1 MB this way), or a path
   * that is not a file, throws; so does any other failure.
   */
  async fileText(repo: Repo, path: string, ref: string, maxBytes: number): Promise<string | undefined> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    let file: { type?: string; size?: number; encoding?: string; content?: string };
    try {
      file = await this.#request<typeof file>('GET', `/repos/${repo.owner}/${repo.name}/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return undefined;
      throw error;
    }
    if (file.type !== 'file') throw new Error(`${path} on ${ref} is not a file`);
    if (typeof file.size !== 'number' || file.size > maxBytes) throw new Error(`${path} on ${ref} is over ${maxBytes} bytes`);
    if (file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error(`${path} on ${ref} came back without its content`);
    return Buffer.from(file.content, 'base64').toString('utf8');
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
