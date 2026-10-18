/**
 * Completing a rework decision: the guards that need GitHub API or ledger
 * lookups — review comments, failing job names, the PR record for
 * `issue_comment`, and the checks-failed cap.
 */
import { mintInstallationToken } from '@factorial/github-app';

import { listPrWorkItems, resolveChecksFailed } from './ledger.ts';
import { buildReworkWorkItem } from './rework-item.ts';
import type { PrEventDecision } from './pr-event.ts';
import type { PullRequestRef, RepositoryRef } from './payloads.ts';
import type { WorkItem } from '@factorial/workitem';

const GITHUB_API = 'https://api.github.com';

interface RestOptions {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  fetchImpl?: typeof fetch;
}

/** The minimal GitHub REST access the trigger needs: read-only, pull_requests scope. */
export class GitHubFetch {
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(token: string, fetchImpl?: typeof fetch) {
    this.#token = token;
    this.#fetch = fetchImpl ?? fetch;
  }

  static async create(repo: RepositoryRef, options: RestOptions): Promise<GitHubFetch> {
    const { token } = await mintInstallationToken(
      { appId: options.appId, installationId: options.installationId, privateKeyPem: options.privateKeyPem },
      { repositories: [repo.name], permissions: { pull_requests: 'read' } },
    );
    return new GitHubFetch(token, options.fetchImpl);
  }

  async #get<T>(repo: RepositoryRef, path: string): Promise<T> {
    const response = await this.#fetch(`${GITHUB_API}/repos/${repo.owner.login}/${repo.name}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.#token}`,
        'user-agent': 'factorial',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub GET ${path} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  /** GET /pulls/{number}, trimmed to the fields the guards check. */
  async getPullRequest(repo: RepositoryRef, number: number): Promise<PullRequestRef> {
    const pr = (await this.#get(repo, `/pulls/${number}`)) as Record<string, unknown>;
    const head = pr.head as { ref: string; sha?: string };
    const base = pr.base as { ref: string };
    const user = pr.user as { login: string; type: string };
    return {
      number: pr.number as number,
      html_url: pr.html_url as string,
      head: { ref: head.ref, sha: head.sha ?? '' },
      base: { ref: base.ref },
      user: { login: user.login, type: user.type },
    };
  }

  /** GET /pulls/{number}/comments — review comments, with file and line. */
  async listReviewComments(
    repo: RepositoryRef,
    number: number,
  ): Promise<Array<{ user: string; body: string; path?: string; line?: number }>> {
    const comments = (await this.#get(repo, `/pulls/${number}/comments?per_page=100`)) as Array<Record<string, unknown>>;
    return comments.map((comment) => ({
      user: (comment.user as { login: string }).login,
      body: comment.body as string,
      ...(comment.path === undefined ? {} : { path: comment.path as string }),
      ...(comment.line === undefined ? {} : { line: comment.line as number }),
    }));
  }

  /** GET /commits/{sha}/check-runs — the failing jobs' names. Logs are not fetched here. */
  async listFailingCheckRuns(repo: RepositoryRef, sha: string): Promise<Array<{ name: string; url: string }>> {
    const page = (await this.#get(
      repo,
      `/commits/${sha}/check-runs?per_page=100`,
    )) as { check_runs?: Array<{ name: string; html_url: string; conclusion: string | null }> };
    return (page.check_runs ?? [])
      .filter((run) => run.conclusion === 'failure')
      .map((run) => ({ name: run.name, url: run.html_url }));
  }
}

export interface ReworkOutcome {
  kind: 'ignore';
  reason: string;
}

/**
 * Turn a rework decision into a WorkItem, doing the lookups the pure decision
 * function cannot: review comments and failing job names from GitHub, and the
 * ledger for previousWorkItemId and the checks-failed cap.
 */
export async function buildRework(
  decision: PrEventDecision,
  repo: RepositoryRef,
  github: GitHubFetch,
  options: { deliveryId: string | undefined; baseBranch: string; botLogin: string },
): Promise<WorkItem | ReworkOutcome> {
  if (decision.kind === 'ignore') return { kind: 'ignore', reason: decision.reason };

  const pullRequest = decision.pullRequest;
  const rows = await listPrWorkItems(pullRequest.number);
  const previous = rows[0]?.workItemId;
  if (previous === undefined) {
    return { kind: 'ignore', reason: 'no WorkItem recorded for this pull request' };
  }

  if (decision.kind === 'rework-checks-failed') {
    const capped = resolveChecksFailed(decision, rows);
    if (capped.kind === 'ignore') return capped;
    const failingJobs = await github.listFailingCheckRuns(repo, decision.headSha);
    return buildReworkWorkItem(decision, [], {
      repository: repo,
      baseBranch: options.baseBranch,
      botLogin: options.botLogin,
      previousWorkItemId: capped.previousWorkItemId,
      failingJobs,
      deliveryId: options.deliveryId,
    });
  }

  // rework-review: gather the PR's review comments addressed to the bot, then
  // add the comment that triggered the decision if it is not already among them.
  const reviewComments = await github.listReviewComments(repo, pullRequest.number);
  const botComments = reviewComments.map((comment) => ({
    author: comment.user,
    body: comment.body,
    ...(comment.path === undefined ? {} : { path: comment.path }),
    ...(comment.line === undefined ? {} : { line: comment.line }),
  }));
  const triggered = decision.comment;
  const triggeredIsReviewComment =
    triggered.path !== undefined && botComments.some((comment) => comment.body === triggered.body && comment.author === triggered.author);
  const additional = triggeredIsReviewComment ? [] : [triggered];
  return buildReworkWorkItem(decision, additional, {
    repository: repo,
    baseBranch: options.baseBranch,
    botLogin: options.botLogin,
    previousWorkItemId: previous,
    deliveryId: options.deliveryId,
  });
}
