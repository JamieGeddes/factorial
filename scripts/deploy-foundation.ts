/**
 * Deploy the foundation stack (`templates/foundation.yml`). Run by a human with
 * administrator credentials, never by the deploy workflow (`docs/bootstrap.md`).
 *
 * The template is uploaded to a bootstrap bucket the human creates by hand and is
 * deployed from there, because an inline template body is limited to 51,200 bytes.
 * The bucket name embeds the account ID, so it comes from the environment or a
 * local, untracked `.env` (`FACTORIAL_BOOTSTRAP_BUCKET`), never from the repository.
 *
 * Usage: node scripts/deploy-foundation.ts
 * Optional: GITHUB_OWNER and GITHUB_REPOSITORY (default: the repository `gh` sees).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const region = 'eu-west-1';
const stackName = 'factorial-foundation';
const template = 'templates/foundation.yml';
const bucketKey = 'FACTORIAL_BOOTSTRAP_BUCKET';

/**
 * Read one key from `.env` text without evaluating it as shell, so nothing else in
 * the file can run. Accepts `KEY=value`, optional `export `, and matching quotes.
 */
export function readEnvValue(text: string, key: string): string | undefined {
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line.startsWith(`${key}=`)) continue;
    let value = line.slice(key.length + 1).trim();
    const quoted = /^(['"])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2] ?? '';
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function main(): void {
  const bucket =
    process.env[bucketKey] ||
    (existsSync('.env') ? readEnvValue(readFileSync('.env', 'utf8'), bucketKey) : undefined);
  if (!bucket) {
    fail(`${bucketKey} is not set. Add it to .env (see .env.example) or the environment.`);
  }

  let bucketRegion: string;
  try {
    bucketRegion = JSON.parse(
      run('aws', ['s3api', 'head-bucket', '--bucket', bucket, '--region', region, '--output', 'json']),
    ).BucketRegion;
  } catch {
    fail(`Bootstrap bucket ${bucket} does not exist or is not accessible. Create it as in docs/bootstrap.md.`);
  }
  if (bucketRegion !== region) {
    fail(`Bootstrap bucket ${bucket} is in ${bucketRegion}; it must be in ${region}, the stack's region.`);
  }

  const owner = process.env.GITHUB_OWNER || run('gh', ['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repository = process.env.GITHUB_REPOSITORY || run('gh', ['repo', 'view', '--json', 'name', '--jq', '.name']);
  const ownerId = run('gh', ['api', `repos/${owner}/${repository}`, '--jq', '.owner.id']);
  const repositoryId = run('gh', ['api', `repos/${owner}/${repository}`, '--jq', '.id']);

  console.log(`Linting ${template}.`);
  execFileSync('cfn-lint', [template], { stdio: 'inherit' });

  console.log(`Deploying ${stackName} for ${owner}/${repository} from s3://${bucket}/foundation/.`);
  execFileSync(
    'aws',
    [
      'cloudformation', 'deploy',
      '--region', region,
      '--stack-name', stackName,
      '--template-file', template,
      '--s3-bucket', bucket,
      '--s3-prefix', 'foundation',
      '--capabilities', 'CAPABILITY_NAMED_IAM',
      '--parameter-overrides',
      `GitHubOwner=${owner}`,
      `GitHubRepository=${repository}`,
      `GitHubOwnerId=${ownerId}`,
      `GitHubRepositoryId=${repositoryId}`,
      '--tags', 'Project=Factorial',
      '--no-fail-on-empty-changeset',
    ],
    { stdio: 'inherit' },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
