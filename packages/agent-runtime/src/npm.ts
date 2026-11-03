/**
 * npm's registry for the agent's commands (#242). When the Runtime version
 * names a CodeArtifact mirror, the host mints a read-only token with the
 * execution role as each run starts, before pi's first model call, and writes
 * it to the agent user's ~/.npmrc as the only line there. The registry itself
 * goes in the environment of every agent command (pi/environment.ts), not in
 * the file: npm takes the environment before a project's .npmrc, so a target
 * repository cannot redirect installs, while a user-level registry line would
 * lose to it.
 *
 * Per run, not at host start: on Runtime V2 the host starts before the
 * version's snapshot (docs/security.md section 9.2a), so a token minted then
 * would be one token shared by every session of the version, expiring hours
 * after promotion.
 *
 * The token is the first credential stored in a session, an accepted
 * divergence recorded in docs/security.md section 7.
 */
import { closeSync, fchownSync, openSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';

import { CodeartifactClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-codeartifact';

import type { Config, NpmMirror } from './config.ts';

/** Time for commands still finishing when the run stops at its limit. */
const TOKEN_MARGIN_SECONDS = 15 * 60;

/**
 * How long the token lasts: the run's time limit and a margin, within what
 * CodeArtifact allows (15 minutes to 12 hours). The token is minted as the run
 * starts and nothing installs after it ends, so it need not outlive the run.
 */
export function tokenSeconds(config: Pick<Config, 'maxDurationSeconds'>): number {
  return Math.min(43_200, Math.max(900, Math.ceil(config.maxDurationSeconds) + TOKEN_MARGIN_SECONDS));
}

/** Mints a CodeArtifact authorization token for the mirror's domain. */
export type MintToken = (mirror: NpmMirror, durationSeconds: number) => Promise<string>;

/** Mints with the SDK's default credential chain: the execution role on the Runtime, as pi/bedrock.ts reaches Bedrock. */
export function codeArtifactToken(region: string): MintToken {
  const client = new CodeartifactClient({ region });
  return async (mirror, durationSeconds) => {
    const { authorizationToken } = await client.send(
      new GetAuthorizationTokenCommand({ domain: mirror.domain, domainOwner: mirror.domainOwner, durationSeconds }),
    );
    if (!authorizationToken) throw new Error('CodeArtifact returned no authorization token');
    return authorizationToken;
  };
}

/** The .npmrc line that authenticates to `registry` and to nothing else. */
export function authTokenLine(registry: string, token: string): string {
  // A token with whitespace in it could end the line and start another setting.
  if (!/^\S+$/.test(token)) throw new Error('the CodeArtifact token is empty or holds whitespace');
  const url = new URL(registry);
  return `//${url.host}${url.pathname}:_authToken=${token}\n`;
}

/**
 * Writes `content` as `home`/.npmrc, owned by the home directory's owner (the
 * agent user) and readable by it alone. Whatever is at the path first is
 * removed, never followed: a link there would otherwise have the root host
 * write wherever it points.
 */
export function writeNpmrc(home: string, content: string): string {
  const target = path.join(home, '.npmrc');
  const { uid, gid } = statSync(home);
  rmSync(target, { force: true });
  // wx: create, failing if anything appeared there since the removal.
  const fd = openSync(target, 'wx', 0o600);
  try {
    fchownSync(fd, uid, gid);
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return target;
}

/**
 * Configures npm for the agent user when the version names a mirror, and
 * returns the registry, or undefined when there is none (the reviewer). A
 * failure to mint throws before pi starts, so the run fails as host_error
 * before any model call rather than at the first install. The variables
 * themselves are checked earlier, when the host starts (config.ts).
 */
export async function configureNpm(
  config: Pick<Config, 'npmMirror' | 'region' | 'agentHome' | 'maxDurationSeconds'>,
  mint?: MintToken,
): Promise<string | undefined> {
  const mirror = config.npmMirror;
  if (!mirror) return undefined;
  const token = await (mint ?? codeArtifactToken(config.region))(mirror, tokenSeconds(config));
  writeNpmrc(config.agentHome, authTokenLine(mirror.registry, token));
  return mirror.registry;
}
