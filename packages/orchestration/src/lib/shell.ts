/** Quote a value for safe interpolation into a POSIX shell command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const GITHUB_TOKEN = /^[A-Za-z0-9_]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
