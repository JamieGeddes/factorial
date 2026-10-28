/**
 * The options for the one `query()` a session runs. Everything comes from the
 * Runtime version's configuration and the host's code; the request contributes
 * only the prompt.
 */
import type { HookCallbackMatcher, McpSdkServerConfigWithInstance, Options } from '@anthropic-ai/claude-agent-sdk';

import type { Config } from './config.ts';
import { agentEnvironment } from './environment.ts';
import type { HostRole } from './roles.ts';
import { TOOL_NAME, SERVER_NAME } from './web-search.ts';

export interface OptionParts {
  hostEnv: NodeJS.ProcessEnv;
  preToolUse: HookCallbackMatcher[];
  postToolUse: HookCallbackMatcher[];
  stop: HookCallbackMatcher[];
  webSearch: McpSdkServerConfigWithInstance | undefined;
  abortController: AbortController;
  stderr: (data: string) => void;
}

/** The role's prompt, tools and subagents. A role that is not offered web search never gets it, whatever the configuration says. */
function roleOptions(config: Config, role: HostRole, parts: OptionParts): Options {
  const webSearch = role.webSearch ? parts.webSearch : undefined;
  return {
    systemPrompt: role.systemPrompt,
    tools: [...role.tools],
    allowedTools: webSearch ? [TOOL_NAME] : [],
    mcpServers: webSearch ? { [SERVER_NAME]: webSearch } : {},
    agents: role.agents(config, webSearch !== undefined),
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
