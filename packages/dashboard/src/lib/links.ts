/**
 * The only links the app makes clickable are those it builds itself: GitHub,
 * from the ledger's repository fields, and the AWS console. A URL found in a
 * record is never followed or rendered as a link.
 */
export const REGION = 'eu-west-1';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{7,40}$/;

export interface Repository {
  owner: string;
  name: string;
}

export function isRepository(value: unknown): value is Repository {
  const repo = value as Partial<Repository> | null;
  return typeof repo?.owner === 'string' && typeof repo.name === 'string' && OWNER.test(repo.owner) && REPO.test(repo.name) && repo.name !== '.' && repo.name !== '..';
}

function github(repo: Repository, path: string): string | undefined {
  return isRepository(repo) ? `https://github.com/${repo.owner}/${repo.name}${path}` : undefined;
}

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

export function issueUrl(repo: Repository, number: unknown): string | undefined {
  return positive(number) ? github(repo, `/issues/${number}`) : undefined;
}

export function pullRequestUrl(repo: Repository, number: unknown): string | undefined {
  return positive(number) ? github(repo, `/pull/${number}`) : undefined;
}

export function commitUrl(repo: Repository, sha: unknown): string | undefined {
  return typeof sha === 'string' && SHA.test(sha) ? github(repo, `/commit/${sha}`) : undefined;
}

export function branchUrl(repo: Repository, branch: unknown): string | undefined {
  return typeof branch === 'string' && /^[A-Za-z0-9._/-]{1,200}$/.test(branch) && !branch.includes('..') ? github(repo, `/tree/${branch}`) : undefined;
}

/** A workflow run's page, when `url` is one in `repo`: the record's URL is never used as it is, only its run number. */
export function actionsRunUrl(repo: Repository, url: unknown): { id: string; url?: string } | undefined {
  const match = typeof url === 'string' ? /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d{1,20})$/.exec(url) : null;
  if (!match || match[1]?.toLowerCase() !== repo.owner.toLowerCase() || match[2]?.toLowerCase() !== repo.name.toLowerCase()) return undefined;
  const id = match[3] as string;
  const page = github(repo, `/actions/runs/${id}`);
  return { id, ...(page ? { url: page } : {}) };
}

const EXECUTION_ARN = /^arn:aws:states:[a-z0-9-]+:\d{12}:execution:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;

export function executionUrl(arn: unknown): string | undefined {
  if (typeof arn !== 'string' || !EXECUTION_ARN.test(arn)) return undefined;
  return `https://${REGION}.console.aws.amazon.com/states/home?region=${REGION}#/v2/executions/details/${arn}`;
}

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX = /^[0-9a-f-]{36}\/\d+\/$/;

export function artefactsUrl(bucket: unknown, prefix: unknown): string | undefined {
  if (typeof bucket !== 'string' || !BUCKET.test(bucket) || typeof prefix !== 'string' || !PREFIX.test(prefix)) return undefined;
  return `https://${REGION}.console.aws.amazon.com/s3/buckets/${bucket}?region=${REGION}&prefix=${encodeURIComponent(prefix)}`;
}
