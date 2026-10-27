/**
 * The host's configuration, read once from the process environment. Every value
 * here is set on the immutable Runtime version (templates/20-agent.yml), never
 * taken from a request, so the model, limits and tools are fixed by the version.
 */
import { ROLES, isRoleName, modelVariable, type RoleName } from '@factorial/roles';

export type Role = RoleName;

export interface Config {
  role: Role;
  // Bedrock inference profile ids, named by what each model does rather than
  // by size, so changing one (Sonnet to Opus for the main loop, say) is one
  // value on the Runtime version.
  /** The role's main loop, e.g. eu.anthropic.claude-sonnet-5-5. */
  model: string;
  /** The explore subagent's, e.g. eu.anthropic.claude-haiku-5-5, for a role whose manifest names the purpose (the builder). */
  exploreModel: string | undefined;
  /** The SDK's own background calls (ANTHROPIC_DEFAULT_HAIKU_MODEL). */
  backgroundModel: string;
  region: string;
  maxTurns: number;
  maxBudgetUsd: number;
  /** Wall-clock limit for the run, below the state machine's Build timeout. */
  maxDurationSeconds: number;
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
  if (!isRoleName(role)) throw new Error(`FACTORIAL_ROLE must be one of ${Object.keys(ROLES).join(', ')}`);
  const maxTurns = positiveNumber(env, 'FACTORIAL_MAX_TURNS');
  if (!Number.isInteger(maxTurns)) throw new Error('FACTORIAL_MAX_TURNS must be an integer');
  return {
    role,
    model: required(env, 'FACTORIAL_MODEL'),
    exploreModel: ROLES[role].models.includes('explore') ? required(env, modelVariable('explore')) : undefined,
    backgroundModel: required(env, 'FACTORIAL_BACKGROUND_MODEL'),
    region: required(env, 'AWS_REGION'),
    maxTurns,
    maxBudgetUsd: positiveNumber(env, 'FACTORIAL_MAX_BUDGET_USD'),
    maxDurationSeconds: positiveNumber(env, 'FACTORIAL_MAX_DURATION_SECONDS'),
    webSearchGatewayUrl: env.FACTORIAL_WEB_SEARCH_GATEWAY_URL || undefined,
    port: 8080,
    workspace: '/workspace',
    agentHome: '/home/agent',
    stateDirectory: '/var/lib/factorial',
    claudeExecutable: '/opt/factorial/agent-runtime/claude-as-agent',
  };
}
