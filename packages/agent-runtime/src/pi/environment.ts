/**
 * The environment of every command pi's tools run as the agent user. Built
 * from the same short allow-list of the host's environment as the Claude
 * Agent SDK subprocess's (claude-sdk/environment.ts), without the SDK's own
 * settings, so the agent's shell has what it has on the SDK host and nothing
 * else the host process holds.
 */
import { PASSED_THROUGH } from '../claude-sdk/environment.ts';
import type { Config } from '../config.ts';

/** The SDK's settings in the allow-list, which a pi shell has no use for. */
const SDK_ONLY = new Set(['ANTHROPIC_BEDROCK_BASE_URL', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH']);

export function shellEnvironment(config: Config, host: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_THROUGH) {
    const value = host[name];
    if (value && !SDK_ONLY.has(name)) env[name] = value;
  }
  return { ...env, HOME: config.agentHome, AWS_REGION: config.region };
}
