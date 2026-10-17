/**
 * GitHub App credentials for the orchestrator. Only these Lambda functions,
 * outside the agent sandbox, can read the private key; every token they mint
 * is scoped to one repository and the permissions one step needs.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';

import {
  GitHubClient,
  botGitIdentity,
  getApp,
  mintInstallationToken,
  type AppCredentials,
  type GitIdentity,
  type Repo,
  type TokenPermissions,
} from '@factorial/github-app';

import { requireEnv } from './env.ts';
import { assertGitHubToken } from './shell.ts';

let cached: AppCredentials | undefined;

export async function appCredentials(): Promise<AppCredentials> {
  if (cached) return cached;
  const appIdParam = requireEnv('GITHUB_APP_ID_PARAM');
  const installationIdParam = requireEnv('GITHUB_INSTALLATION_ID_PARAM');
  const privateKeySecret = requireEnv('GITHUB_PRIVATE_KEY_SECRET');

  const [params, key] = await Promise.all([
    new SSMClient({}).send(new GetParametersCommand({ Names: [appIdParam, installationIdParam] })),
    new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: privateKeySecret })),
  ]);
  const byName = new Map((params.Parameters ?? []).map((p) => [p.Name, p.Value]));
  const appId = byName.get(appIdParam);
  const installationId = byName.get(installationIdParam);
  if (!appId || !installationId) {
    throw new Error(`Missing SSM parameters ${appIdParam} and/or ${installationIdParam}`);
  }
  if (!key.SecretString) {
    throw new Error(`Secret ${privateKeySecret} has no value`);
  }
  cached = { appId, installationId, privateKeyPem: key.SecretString };
  return cached;
}

/** A one-hour token limited to one repository and the given permissions. */
export async function repositoryToken(repo: Repo, permissions: TokenPermissions): Promise<string> {
  const { token } = await mintInstallationToken(await appCredentials(), { repositories: [repo.name], permissions });
  return assertGitHubToken(token);
}

export async function repositoryClient(repo: Repo, permissions: TokenPermissions): Promise<GitHubClient> {
  return new GitHubClient({ token: await repositoryToken(repo, permissions) });
}

let cachedIdentity: GitIdentity | undefined;

/**
 * The identity every commit Factorial pushes is attributed to: the App's bot
 * user. Whatever name the agent used inside the sandbox is discarded.
 */
export async function commitIdentity(repo: Repo): Promise<GitIdentity> {
  if (cachedIdentity) return cachedIdentity;
  const { slug } = await getApp(await appCredentials());
  const bot = await (await repositoryClient(repo, { metadata: 'read' })).getUser(`${slug}[bot]`);
  if (bot.type !== 'Bot') {
    throw new Error(`${slug}[bot] is not a bot account`);
  }
  cachedIdentity = botGitIdentity(slug, bot.id);
  return cachedIdentity;
}
