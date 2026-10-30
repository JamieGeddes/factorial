/**
 * The environment of every command pi's tools run as the agent user: a short
 * allow-list of the host's environment, plus the agent's home and the region.
 * No AWS credentials: pi's loop calls Bedrock from the host, so the shell needs
 * none. Nothing else the host process holds reaches the shell.
 */
import type { Config } from '../config.ts';

/** Passed through from the host when present. */
const PASSED_THROUGH: readonly string[] = ['PATH', 'LANG', 'TZ'];

export function shellEnvironment(config: Config, host: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_THROUGH) {
    const value = host[name];
    if (value) env[name] = value;
  }
  return { ...env, HOME: config.agentHome, AWS_REGION: config.region };
}
