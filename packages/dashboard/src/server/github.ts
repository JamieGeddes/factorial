import 'server-only';

import { isRepository } from '../lib/links.ts';
import { memo } from './cache.ts';

/**
 * The deploy workflow's runs on `main` (#59), from the GitHub Actions API.
 * The repository is public, so no token is needed; `GITHUB_TOKEN` from the
 * reviewer's environment, when set, raises the rate limit from 60 requests
 * an hour to 5,000 and is sent to api.github.com only, from the server. A
 * finished run's jobs and annotations never change, so they are kept for the
 * life of the process: a cold start reads at most one list and two requests
 * per run, and after that one list every two minutes.
 */
export interface DeployRun {
  id: number;
  attempt: number;
  sha: string;
  /** The head commit's first line. */
  title: string;
  at: string;
  status: 'deployed' | 'skipped' | 'failed' | 'running' | 'cancelled';
  /** The stacks the run changed, from its `Stacks deployed` notice; undefined when the run does not record them. */
  stacks?: string[];
  /** Each live endpoint moved, from its `Runtimes promoted` notice. */
  promoted?: { runtime: string; version: string }[];
}

export type Fetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

const API = 'https://api.github.com';
const DEPLOY_JOB = 'Deploy Factorial stacks';

type RawRun = { id?: number; run_attempt?: number; head_sha?: string; head_commit?: { message?: string }; run_started_at?: string; created_at?: string; status?: string; conclusion?: string | null };
type RawJob = { id?: number; name?: string; status?: string; conclusion?: string | null };
type RawAnnotation = { title?: string; message?: string; annotation_level?: string };

/** A run's title: a merge commit's pull request title (its body's first line) as `Merge PR #236: <title>`, else the first line. */
export function commitTitle(message: string): string {
  const lines = message.split('\n').map((l) => l.trim());
  const pr = /^Merge pull request #(\d+) from /.exec(lines[0] ?? '');
  const body = lines.slice(1).find((l) => l.length > 0);
  return pr && body ? `Merge PR #${pr[1]}: ${body}` : (lines[0] ?? '');
}

/** A notice's runtimes: `factorial_builder 47, factorial_reviewer 31`, or `none`. */
export function parsePromoted(message: string): { runtime: string; version: string }[] {
  if (message.trim() === 'none') return [];
  return message.split(',').flatMap((part) => {
    const m = /^\s*([A-Za-z0-9_]{1,64}) (\d{1,6})\s*$/.exec(part);
    return m ? [{ runtime: m[1] as string, version: m[2] as string }] : [];
  });
}

/** A notice's stacks: `agent orchestration`, or `none`. */
export function parseStacks(message: string): string[] {
  if (message.trim() === 'none') return [];
  return message.split(/\s+/).filter((s) => /^[a-z][a-z0-9-]{0,40}$/.test(s));
}

export function createGitHub(options: { repository: string; token?: string | undefined; fetch?: Fetch; ttlMs?: number; limit?: number }) {
  const [owner = '', name = ''] = options.repository.split('/');
  if (!isRepository({ owner, name }) || options.repository.split('/').length !== 2) throw new Error(`not a repository: ${options.repository}`);
  const doFetch: Fetch = options.fetch ?? ((url, init) => fetch(url, init) as ReturnType<Fetch>);
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'factorial-command-centre' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const get = async (path: string): Promise<unknown> => {
    const response = await doFetch(`${API}/repos/${owner}/${name}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      const limited = (response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0';
      throw new Error(limited ? `GitHub API rate limit reached${options.token ? '' : '; set GITHUB_TOKEN to raise it'}` : `GitHub API returned ${response.status}`);
    }
    return response.json();
  };

  /** Finished runs' facts, kept for good. */
  const finished = new Map<string, Pick<DeployRun, 'status' | 'stacks' | 'promoted'>>();

  const details = async (run: RawRun): Promise<Pick<DeployRun, 'status' | 'stacks' | 'promoted'>> => {
    const key = `${run.id}/${run.run_attempt ?? 1}`;
    const hit = finished.get(key);
    if (hit) return hit;
    if (run.status !== 'completed') return { status: 'running' };
    const jobs = ((await get(`/actions/runs/${run.id}/attempts/${run.run_attempt ?? 1}/jobs`)) as { jobs?: RawJob[] }).jobs ?? [];
    const deploy = jobs.find((j) => j.name === DEPLOY_JOB);
    const status: DeployRun['status'] =
      run.conclusion === 'cancelled' ? 'cancelled' : run.conclusion !== 'success' ? 'failed' : !deploy || deploy.conclusion === 'skipped' ? 'skipped' : 'deployed';
    const out: Pick<DeployRun, 'status' | 'stacks' | 'promoted'> = { status };
    if (deploy?.id && deploy.conclusion !== 'skipped') {
      const annotations = (await get(`/check-runs/${deploy.id}/annotations?per_page=50`)) as RawAnnotation[];
      for (const a of Array.isArray(annotations) ? annotations : []) {
        if (a.annotation_level !== 'notice' || typeof a.message !== 'string') continue;
        if (a.title === 'Stacks deployed') out.stacks = parseStacks(a.message);
        if (a.title === 'Runtimes promoted') out.promoted = parsePromoted(a.message);
      }
    }
    finished.set(key, out);
    return out;
  };

  const runs = memo(async (): Promise<DeployRun[]> => {
    const list = ((await get(`/actions/workflows/deploy.yml/runs?branch=main&per_page=${options.limit ?? 10}`)) as { workflow_runs?: RawRun[] }).workflow_runs ?? [];
    return Promise.all(
      list
        .filter((r) => typeof r.id === 'number' && typeof r.head_sha === 'string' && /^[0-9a-f]{40}$/.test(r.head_sha))
        .map(async (r): Promise<DeployRun> => ({
          id: r.id as number,
          attempt: r.run_attempt ?? 1,
          sha: r.head_sha as string,
          title: commitTitle(r.head_commit?.message ?? ''),
          at: r.run_started_at ?? r.created_at ?? '',
          ...(await details(r)),
        })),
    );
  }, options.ttlMs ?? 120_000);

  return { deploys: () => runs.get(), repository: { owner, name } };
}

export type GitHub = ReturnType<typeof createGitHub>;
