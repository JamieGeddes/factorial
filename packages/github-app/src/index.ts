/**
 * GitHub App authentication without dependencies: an RS256 JWT signed with the
 * App's private key, exchanged for a short-lived installation access token.
 */
import { createSign } from 'node:crypto';

export { GitHubApiError, GitHubClient, type CheckJob, type PullRequest, type PullRequestState, type Repo, type ReviewComment } from './rest.ts';

export interface AppCredentials {
  appId: string;
  installationId: string;
  privateKeyPem: string;
}

export interface InstallationToken {
  token: string;
  /** RFC 3339 expiry, about one hour after minting. */
  expiresAt: string;
}

/** GitHub App permission levels a token may be narrowed to. */
export type TokenPermissions = Record<string, 'read' | 'write'>;

export interface MintOptions {
  /** Restrict the token to these repository names within the installation. */
  repositories?: string[];
  /** Restrict the token to a subset of the App's permissions, e.g. { contents: 'read' }. */
  permissions?: TokenPermissions;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** Override for tests, seconds since the epoch. */
  nowSeconds?: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Build the App JWT GitHub requires to call App endpoints. Valid for nine minutes. */
export function createAppJwt(appId: string, privateKeyPem: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  // Issued 60s in the past to tolerate clock skew, as GitHub recommends.
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256').update(signingInput).end().sign(privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

/** Exchange the App JWT for an installation access token. */
export async function mintInstallationToken(
  credentials: AppCredentials,
  options: MintOptions = {},
): Promise<InstallationToken> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const jwt = createAppJwt(credentials.appId, credentials.privateKeyPem, options.nowSeconds);
  const scope: { repositories?: string[]; permissions?: TokenPermissions } = {};
  if (options.repositories) scope.repositories = options.repositories;
  if (options.permissions) scope.permissions = options.permissions;
  const body = Object.keys(scope).length > 0 ? JSON.stringify(scope) : undefined;

  const response = await fetchImpl(
    `https://api.github.com/app/installations/${encodeURIComponent(credentials.installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
        'user-agent': 'factorial',
        'x-github-api-version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body }),
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub installation token request failed: ${response.status} ${await response.text()}`);
  }
  const json = (await response.json()) as { token?: unknown; expires_at?: unknown };
  if (typeof json.token !== 'string' || typeof json.expires_at !== 'string') {
    throw new Error('GitHub installation token response was malformed');
  }
  return { token: json.token, expiresAt: json.expires_at };
}

export interface AppInfo {
  id: number;
  slug: string;
  name: string;
}

/** The App's own record, which carries the slug its bot user is named after. */
export async function getApp(
  credentials: Pick<AppCredentials, 'appId' | 'privateKeyPem'>,
  options: { fetchImpl?: typeof fetch; nowSeconds?: number } = {},
): Promise<AppInfo> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const jwt = createAppJwt(credentials.appId, credentials.privateKeyPem, options.nowSeconds);
  const response = await fetchImpl('https://api.github.com/app', {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${jwt}`,
      'user-agent': 'factorial',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub app lookup failed: ${response.status} ${await response.text()}`);
  }
  const json = (await response.json()) as { id?: unknown; slug?: unknown; name?: unknown };
  if (typeof json.id !== 'number' || typeof json.slug !== 'string' || typeof json.name !== 'string') {
    throw new Error('GitHub app response was malformed');
  }
  return { id: json.id, slug: json.slug, name: json.name };
}

export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * The git author/committer identity GitHub attributes to the App's bot user:
 * `<slug>[bot]` with its noreply address. The numeric part is the bot user's
 * id (GET /users/<slug>[bot]), not the App id.
 */
export function botGitIdentity(slug: string, botUserId: number): GitIdentity {
  const login = `${slug}[bot]`;
  return { name: login, email: `${botUserId}+${login}@users.noreply.github.com` };
}
