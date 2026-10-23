/**
 * The SDK subprocess's environment. The SDK's `env` option replaces the
 * subprocess environment entirely, so it is built from a short allow-list of the
 * host's own environment plus fixed settings. Nothing from a request reaches it,
 * and anything else the host process holds stays out of the model's shell.
 */
import type { Config } from './config.ts';

/** Passed through from the host when present. */
export const PASSED_THROUGH: readonly string[] = [
  'PATH',
  'LANG',
  'TZ',
  // Credentials for SigV4 to Bedrock: the Runtime supplies the execution role
  // through the container credential variables; the static ones are for local
  // runs of the image only.
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  // A Bedrock endpoint override, for running the image against a local stub.
  'ANTHROPIC_BEDROCK_BASE_URL',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
];

export function agentEnvironment(config: Config, host: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASSED_THROUGH) {
    const value = host[name];
    if (value) env[name] = value;
  }
  return {
    ...env,
    // The host runs as root; the subprocess runs as the agent user.
    HOME: config.agentHome,
    CLAUDE_CONFIG_DIR: `${config.workspace}/.claude`,
    AWS_REGION: config.region,
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_MODEL: config.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.smallModel,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
    CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '4',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'factorial-agent-runtime/0.1.0',
  };
}
