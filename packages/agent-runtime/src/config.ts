/**
 * The host's configuration, read once from the process environment. Every value
 * here is set on the immutable Runtime version (templates/agent.yml), never
 * taken from a request, so the model, limits and tools are fixed by the version.
 */
import { ROLES, isRoleName, modelVariable, type RoleName } from '@factorial/roles';
import { RUN_CONTRACT, RUN_CONTRACT_VARIABLE } from '@factorial/run';

export type Role = RoleName;

/** Reasoning effort, where the model takes one. Unset leaves pi's default (medium). */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * The CodeArtifact repository npm installs from (#242), named by three
 * variables on the Runtime version. The builder's version names it; the
 * reviewer's names none and installs nothing.
 */
export interface NpmMirror {
  domain: string;
  /** The account that owns the domain. */
  domainOwner: string;
  repository: string;
  /** The repository's npm endpoint, built from the three and the region, ending in a slash. */
  registry: string;
}

/** The variables that name the mirror: all three or none. */
export const NPM_MIRROR_VARIABLES = {
  domain: 'FACTORIAL_CODEARTIFACT_DOMAIN',
  domainOwner: 'FACTORIAL_CODEARTIFACT_DOMAIN_OWNER',
  repository: 'FACTORIAL_CODEARTIFACT_REPOSITORY',
} as const;

// CodeArtifact's own name rules, so nothing else reaches the registry URL or the .npmrc line built from it.
const DOMAIN_NAME = /^[a-z][a-z0-9-]{0,48}[a-z0-9]$/;
const ACCOUNT_ID = /^[0-9]{12}$/;
const REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-[0-9]$/;

export function readNpmMirror(env: NodeJS.ProcessEnv, region: string): NpmMirror | undefined {
  const names = Object.values(NPM_MIRROR_VARIABLES);
  const set = names.filter((name) => env[name]);
  if (set.length === 0) return undefined;
  if (set.length < names.length) throw new Error(`${names.join(', ')} must be set together; only ${set.join(', ')} is set`);
  const domain = env[NPM_MIRROR_VARIABLES.domain]!;
  const domainOwner = env[NPM_MIRROR_VARIABLES.domainOwner]!;
  const repository = env[NPM_MIRROR_VARIABLES.repository]!;
  if (!DOMAIN_NAME.test(domain)) throw new Error(`${NPM_MIRROR_VARIABLES.domain} is not a CodeArtifact domain name`);
  if (!ACCOUNT_ID.test(domainOwner)) throw new Error(`${NPM_MIRROR_VARIABLES.domainOwner} must be a 12-digit account id`);
  if (!REPOSITORY_NAME.test(repository)) throw new Error(`${NPM_MIRROR_VARIABLES.repository} is not a CodeArtifact repository name`);
  if (!REGION.test(region)) throw new Error(`AWS_REGION (${region}) is not a region name`);
  const registry = `https://${domain}-${domainOwner}.d.codeartifact.${region}.amazonaws.com/npm/${repository}/`;
  return { domain, domainOwner, repository, registry };
}

export interface Config {
  role: Role;
  effort: Effort | undefined;
  // Bedrock inference profile ids, named by what each model does rather than
  // by size, so changing one (Sonnet to Opus for the main loop, say) is one
  // value on the Runtime version.
  /** The role's main loop, e.g. eu.anthropic.claude-sonnet-5-5. */
  model: string;
  /** The explore subagent's, e.g. eu.anthropic.claude-haiku-5-5, for a role whose manifest names the purpose (the builder). */
  exploreModel: string | undefined;
  /** Background calls: the fetch tool's answers from a page. */
  backgroundModel: string;
  region: string;
  maxTurns: number;
  maxBudgetUsd: number;
  /** Wall-clock limit for the run, below the state machine's Build timeout. */
  maxDurationSeconds: number;
  /** Where npm installs from; npm's default registry when unset (#242). */
  npmMirror: NpmMirror | undefined;
  /** The AgentCore web search gateway's MCP URL; web search is off when unset. */
  webSearchGatewayUrl: string | undefined;
  /** The AWS documentation gateway's MCP URL; the AWS documentation tools are off when unset. */
  awsDocsGatewayUrl: string | undefined;
  port: number;
  workspace: string;
  /** The target repository's clone, inside the workspace: where shell commands start. */
  repository: string;
  /** The agent user's home directory. */
  agentHome: string;
  /** Where the host keeps the run's record: root-owned, out of the agent user's reach. */
  stateDirectory: string;
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
  // The version declares the run contract its host speaks, and the invoker
  // reads the declaration before it invokes; this keeps the two in step.
  if (env[RUN_CONTRACT_VARIABLE] !== String(RUN_CONTRACT)) throw new Error(`${RUN_CONTRACT_VARIABLE} must be ${RUN_CONTRACT}, the run contract this host speaks`);
  const role = required(env, 'FACTORIAL_ROLE');
  if (!isRoleName(role)) throw new Error(`FACTORIAL_ROLE must be one of ${Object.keys(ROLES).join(', ')}`);
  const maxTurns = positiveNumber(env, 'FACTORIAL_MAX_TURNS');
  if (!Number.isInteger(maxTurns)) throw new Error('FACTORIAL_MAX_TURNS must be an integer');
  const effort = env.FACTORIAL_EFFORT || undefined;
  if (effort !== undefined && !(EFFORTS as readonly string[]).includes(effort)) throw new Error(`FACTORIAL_EFFORT must be one of ${EFFORTS.join(', ')}`);
  const region = required(env, 'AWS_REGION');
  return {
    role,
    effort: effort as Effort | undefined,
    model: required(env, 'FACTORIAL_MODEL'),
    exploreModel: ROLES[role].models.includes('explore') ? required(env, modelVariable('explore')) : undefined,
    backgroundModel: required(env, 'FACTORIAL_BACKGROUND_MODEL'),
    region,
    maxTurns,
    maxBudgetUsd: positiveNumber(env, 'FACTORIAL_MAX_BUDGET_USD'),
    maxDurationSeconds: positiveNumber(env, 'FACTORIAL_MAX_DURATION_SECONDS'),
    npmMirror: readNpmMirror(env, region),
    webSearchGatewayUrl: env.FACTORIAL_WEB_SEARCH_GATEWAY_URL || undefined,
    awsDocsGatewayUrl: env.FACTORIAL_AWS_DOCS_GATEWAY_URL || undefined,
    port: 8080,
    workspace: '/workspace',
    repository: '/workspace/repo',
    agentHome: '/home/agent',
    stateDirectory: '/var/lib/factorial',
  };
}
