/**
 * The host's configuration, read once from the process environment. Every value
 * here is set on the immutable Runtime version (templates/20-agent.yml), never
 * taken from a request, so the model, limits and tools are fixed by the version.
 */

export type Role = 'builder';

export interface Config {
  role: Role;
  /** Bedrock inference profile id for the main loop, e.g. eu.anthropic.claude-sonnet-5-5. */
  model: string;
  /** Inference profile id for the SDK's small background calls. */
  smallModel: string;
  region: string;
  maxTurns: number;
  maxBudgetUsd: number;
  /** The AgentCore web search gateway's MCP URL; web search is off when unset. */
  webSearchGatewayUrl: string | undefined;
  port: number;
  workspace: string;
  /** The agent user's home directory. */
  agentHome: string;
  /** Where the host keeps the run's record: root-owned, out of the agent user's reach. */
  stateDirectory: string;
  /** Starts Claude Code as the agent user (agent-runtime/claude-as-agent). */
  claudeExecutable: string;
}

const ROLES: readonly Role[] = ['builder'];

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function positiveNumber(env: NodeJS.ProcessEnv, name: string): number {
  const value = Number(required(env, name));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  const role = required(env, 'FACTORIAL_ROLE');
  if (!ROLES.includes(role as Role)) throw new Error(`FACTORIAL_ROLE must be one of ${ROLES.join(', ')}`);
  const maxTurns = positiveNumber(env, 'FACTORIAL_MAX_TURNS');
  if (!Number.isInteger(maxTurns)) throw new Error('FACTORIAL_MAX_TURNS must be an integer');
  return {
    role: role as Role,
    model: required(env, 'FACTORIAL_MODEL'),
    smallModel: required(env, 'FACTORIAL_SMALL_MODEL'),
    region: required(env, 'AWS_REGION'),
    maxTurns,
    maxBudgetUsd: positiveNumber(env, 'FACTORIAL_MAX_BUDGET_USD'),
    webSearchGatewayUrl: env.FACTORIAL_WEB_SEARCH_GATEWAY_URL || undefined,
    port: 8080,
    workspace: '/workspace',
    agentHome: '/home/agent',
    stateDirectory: '/var/lib/factorial',
    claudeExecutable: '/opt/factorial/agent-runtime/claude-as-agent',
  };
}
