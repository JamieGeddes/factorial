/**
 * The environment of every command pi's tools run as the agent user. Built
 * from the same short allow-list of the host's environment as the Claude
 * Agent SDK subprocess's (claude-sdk/environment.ts), without the SDK's own
 * settings and without AWS credentials: pi's loop calls Bedrock from the host,
 * so the shell needs none, where the SDK's subprocess made the calls itself.
 * Nothing else the host process holds reaches the shell.
 */
import { PASSED_THROUGH } from '../claude-sdk/environment.ts';
import type { Config } from '../config.ts';

/** What a pi shell has no use for: the SDK's settings, and the credentials only the host's model calls need. */
const HOST_ONLY = new Set([
  'ANTHROPIC_BEDROCK_BASE_URL',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
]);

export function shellEnvironment(config: Config, host: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_THROUGH) {
    const value = host[name];
    if (value && !HOST_ONLY.has(name)) env[name] = value;
  }
  return { ...env, HOME: config.agentHome, AWS_REGION: config.region };
}
