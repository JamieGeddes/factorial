/**
 * factorial-github-token: mint a GitHub App installation token from inside the
 * agent environment, using the session's AWS credentials. The private key never
 * leaves AWS; only a one-hour token is produced.
 *
 *   factorial-github-token [--repo <name>]      print a token
 *   factorial-github-token git-credential get   act as a git credential helper
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';

import { mintInstallationToken } from '@factorial/github-app';

import { parseGitCredentialInput, shouldAnswer } from './git-credential.ts';

const APP_ID_PARAM = '/factorial/github/app-id';
const INSTALLATION_ID_PARAM = '/factorial/github/installation-id';
const PRIVATE_KEY_SECRET = 'factorial/github/app-private-key';

async function loadCredentials() {
  const ssm = new SSMClient({});
  const secrets = new SecretsManagerClient({});
  const [params, key] = await Promise.all([
    ssm.send(new GetParametersCommand({ Names: [APP_ID_PARAM, INSTALLATION_ID_PARAM] })),
    secrets.send(new GetSecretValueCommand({ SecretId: PRIVATE_KEY_SECRET })),
  ]);
  const byName = new Map((params.Parameters ?? []).map((p) => [p.Name, p.Value]));
  const appId = byName.get(APP_ID_PARAM);
  const installationId = byName.get(INSTALLATION_ID_PARAM);
  if (!appId || !installationId) {
    throw new Error(`Missing SSM parameters ${APP_ID_PARAM} and/or ${INSTALLATION_ID_PARAM}`);
  }
  if (!key.SecretString) {
    throw new Error(`Secret ${PRIVATE_KEY_SECRET} has no value`);
  }
  return { appId, installationId, privateKeyPem: key.SecretString };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'git-credential') {
    // Git calls the helper for get, store and erase. Only get needs an answer;
    // anything else must exit quietly so git carries on.
    if (argv[1] !== 'get') return 0;
    const request = parseGitCredentialInput(await readStdin());
    if (!shouldAnswer(request)) return 0;
    const { token } = await mintInstallationToken(await loadCredentials());
    process.stdout.write(`username=x-access-token\npassword=${token}\n`);
    return 0;
  }

  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write('usage: factorial-github-token [--repo <name>] | git-credential get\n');
    return 0;
  }

  const repoIndex = argv.indexOf('--repo');
  const repo = repoIndex >= 0 ? argv[repoIndex + 1] : undefined;
  const { token } = await mintInstallationToken(await loadCredentials(), repo ? { repositories: [repo] } : {});
  process.stdout.write(`${token}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`factorial-github-token: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
