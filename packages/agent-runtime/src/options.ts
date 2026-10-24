/**
 * The options for the one `query()` a session runs. Everything comes from the
 * Runtime version's configuration and the host's code; the request contributes
 * only the prompt.
 */
import type { HookCallbackMatcher, McpSdkServerConfigWithInstance, Options } from '@anthropic-ai/claude-agent-sdk';

import { builderAgents } from './agents.ts';
import type { Config } from './config.ts';
import { agentEnvironment } from './environment.ts';
import { builderPrompt } from './prompts/builder.ts';
import { TOOL_NAME, SERVER_NAME } from './web-search.ts';

/** The built-in tools the builder may use. `Agent` starts the subagents in agents.ts. */
export const BUILDER_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Agent'];

export interface OptionParts {
  hostEnv: NodeJS.ProcessEnv;
  preToolUse: HookCallbackMatcher[];
  stop: HookCallbackMatcher[];
  webSearch: McpSdkServerConfigWithInstance | undefined;
  abortController: AbortController;
  stderr: (data: string) => void;
}

export function queryOptions(config: Config, parts: OptionParts): Options {
  return {
    cwd: config.workspace,
    model: config.model,
    systemPrompt: builderPrompt,
    tools: BUILDER_TOOLS,
    allowedTools: parts.webSearch ? [TOOL_NAME] : [],
    mcpServers: parts.webSearch ? { [SERVER_NAME]: parts.webSearch } : {},
    strictMcpConfig: true,
    agents: builderAgents(config),
    hooks: { PreToolUse: parts.preToolUse, Stop: parts.stop },
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
