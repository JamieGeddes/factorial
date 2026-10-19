/** Quote a value for safe interpolation into a POSIX shell command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
// Installation tokens are the only GitHub credential Factorial handles. Since
// October 2026 they are stateless: still prefixed ghs_, but around 520
// characters and containing dots and hyphens. This is GitHub's recommended
// validation pattern.
const GITHUB_TOKEN = /^ghs_[A-Za-z0-9._-]{36,}$/;
const GIT_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const IDENTITY_NAME = /^[A-Za-z0-9][A-Za-z0-9._ [\]-]*$/;
const IDENTITY_EMAIL = /^[A-Za-z0-9+._[\]-]+@[A-Za-z0-9.-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reject anything that is not a plain branch name before it reaches a shell. */
export function assertGitBranch(value: string, what: string): string {
  if (!GIT_BRANCH.test(value) || value.includes('..') || value.endsWith('.lock')) {
    throw new Error(`${what} "${value}" is not a valid branch name`);
  }
  return value;
}

/** A git author identity made only of characters safe to place in a shell command. */
export function assertGitIdentity(identity: { name: string; email: string }): { name: string; email: string } {
  if (!IDENTITY_NAME.test(identity.name) || !IDENTITY_EMAIL.test(identity.email)) {
    throw new Error('Commit identity has an unexpected format');
  }
  return identity;
}

/** Reject anything that is not a plausible GitHub owner or repository name before it reaches a shell. */
export function assertGitHubName(value: string, what: string): string {
  if (!GITHUB_NAME.test(value) || value.endsWith('.git')) {
    throw new Error(`${what} "${value}" is not a valid GitHub name`);
  }
  return value;
}

export function assertGitHubToken(value: string): string {
  if (!GITHUB_TOKEN.test(value)) {
    throw new Error('GitHub token has an unexpected format');
  }
  return value;
}

export function assertUuid(value: string, what: string): string {
  if (!UUID.test(value)) {
    throw new Error(`${what} "${value}" is not a UUID`);
  }
  return value;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

export function assertCommitSha(value: string, what: string): string {
  if (!COMMIT_SHA.test(value)) {
    throw new Error(`${what} "${value}" is not a commit sha`);
  }
  return value;
}

/**
 * Authenticate git over HTTPS with a header instead of a URL, so the token
 * never appears in remote URLs, hook arguments or reflog messages.
 */
export function gitAuthHeader(token: string): string {
  const basic = Buffer.from(`x-access-token:${assertGitHubToken(token)}`, 'utf8').toString('base64');
  return `AUTHORIZATION: basic ${basic}`;
}

/** Environment that keeps git from reading any configuration the agent could have planted. */
export const HARDENED_GIT_ENV =
  'export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false';
