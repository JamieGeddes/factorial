/**
 * The environment of every command pi's tools run as the agent user: a short
 * allow-list of the host's environment, plus the agent's home, the region,
 * plain-text output settings and, when the version names a mirror, npm's
 * registry. No AWS credentials: pi's
 * loop calls Bedrock from the host, so the shell needs none. Nothing else the
 * host process holds reaches the shell.
 */
import type { Config } from '../config.ts';

/**
 * Passed through from the host when present, each by name: npm takes any
 * NPM_CONFIG_* variable as a setting, so a prefix would let a host variable
 * such as NPM_CONFIG_USERCONFIG reach the shell. The npm settings and CI are
 * the image's (agent-runtime/Dockerfile): no audit, which CodeArtifact does not
 * serve, no funding notices, no update check, and non-interactive toolchains.
 */
const PASSED_THROUGH: readonly string[] = ['PATH', 'LANG', 'TZ', 'CI', 'NPM_CONFIG_AUDIT', 'NPM_CONFIG_FUND', 'NPM_CONFIG_UPDATE_NOTIFIER'];

/**
 * Plain text from every toolchain: colour sequences in a tool result are
 * written to the prompt cache and resent on every later model call (#247).
 */
const PLAIN_OUTPUT: Readonly<Record<string, string>> = { NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' };

export function shellEnvironment(config: Config, host: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_THROUGH) {
    const value = host[name];
    if (value) env[name] = value;
  }
  // The registry is set here, not in ~/.npmrc: npm takes the environment
  // before a project's .npmrc, so the target repository cannot redirect
  // installs (npm.ts). The token for it is in ~/.npmrc.
  const npm = config.npmMirror ? { NPM_CONFIG_REGISTRY: config.npmMirror.registry } : {};
  return { ...env, ...PLAIN_OUTPUT, HOME: config.agentHome, AWS_REGION: config.region, ...npm };
}
