/**
 * The options for the one `query()` a session runs. Everything comes from the
 * Runtime version's configuration and the host's code; the request contributes
 * only the prompt.
 */
import type { AgentDefinition, HookCallbackMatcher, McpSdkServerConfigWithInstance, Options } from '@anthropic-ai/claude-agent-sdk';

import type { SubagentSpec } from '../agents.ts';
import type { Config } from '../config.ts';
import type { HostRole } from '../roles.ts';
import { agentEnvironment } from './environment.ts';
import { CLAUDE_TOOLS } from './tools.ts';
import { SERVER_NAME, TOOL_NAME } from './web-search.ts';

export interface OptionParts {
  hostEnv: NodeJS.ProcessEnv;
  preToolUse: HookCallbackMatcher[];
  postToolUse: HookCallbackMatcher[];
  stop: HookCallbackMatcher[];
  webSearch: McpSdkServerConfigWithInstance | undefined;
  abortController: AbortController;
  stderr: (data: string) => void;
}

/** A subagent spec as the SDK's definition, on the SDK's tool names. */
export function agentDefinition(config: Config, spec: SubagentSpec, webSearch: boolean): AgentDefinition {
  const model = spec.model === 'inherit' ? 'inherit' : config.exploreModel;
  return {
    description: spec.description,
    prompt: spec.prompt(CLAUDE_TOOLS),
    tools: spec.tools.filter((kind) => kind !== 'webSearch' || webSearch).map((kind) => CLAUDE_TOOLS[kind]),
    // The full inference profile id from the Runtime version, not an alias;
    // readConfig requires the explore model for a role whose manifest names it.
    ...(model ? { model } : {}),
    maxTurns: spec.maxTurns,
  };
}

/** The role's prompt, tools and subagents. A role that is not offered web search never gets it, whatever the configuration says. */
function roleOptions(config: Config, role: HostRole, parts: OptionParts): Options {
  const webSearch = role.webSearch ? parts.webSearch : undefined;
  return {
    systemPrompt: role.systemPrompt(CLAUDE_TOOLS),
    tools: role.tools.map((kind) => CLAUDE_TOOLS[kind]),
    allowedTools: webSearch ? [TOOL_NAME] : [],
    mcpServers: webSearch ? { [SERVER_NAME]: webSearch } : {},
    agents: Object.fromEntries(Object.entries(role.subagents).map(([name, spec]) => [name, agentDefinition(config, spec, webSearch !== undefined)])),
  };
}

export function queryOptions(config: Config, role: HostRole, parts: OptionParts): Options {
  return {
    cwd: config.workspace,
    model: config.model,
    ...roleOptions(config, role, parts),
    strictMcpConfig: true,
    hooks: { PreToolUse: parts.preToolUse, PostToolUse: parts.postToolUse, Stop: parts.stop },
    settingSources: [],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    env: agentEnvironment(config, parts.hostEnv),
    pathToClaudeCodeExecutable: config.claudeExecutable,
    persistSession: true,
    abortController: parts.abortController,
    stderr: parts.stderr,
  };
}
