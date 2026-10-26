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
import { reviewerPrompt } from './prompts/reviewer.ts';
import { TOOL_NAME, SERVER_NAME } from './web-search.ts';

/** The built-in tools the builder may use. `WebFetch` reads a page through the Claude Code subprocess (no permission rule: bypassPermissions skips its prompt; never add an `ask` rule). `Agent` starts the subagents in agents.ts (explore and plan). */
export const BUILDER_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch', 'Agent'];

/** The reviewer's: it reads, and its PreToolUse hook lets Write and Edit reach only /workspace/review.json. No subagents and no web search: everything it judges is in the session. */
export const REVIEWER_TOOLS = ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit'];

export interface OptionParts {
  hostEnv: NodeJS.ProcessEnv;
  preToolUse: HookCallbackMatcher[];
  postToolUse: HookCallbackMatcher[];
  stop: HookCallbackMatcher[];
  webSearch: McpSdkServerConfigWithInstance | undefined;
  abortController: AbortController;
  stderr: (data: string) => void;
}

/** The role's prompt, tools and subagents. The reviewer is never offered web search, whatever the configuration says. */
function roleOptions(config: Config, parts: OptionParts): Options {
  if (config.role === 'reviewer') {
    return { systemPrompt: reviewerPrompt, tools: REVIEWER_TOOLS, allowedTools: [], mcpServers: {}, agents: {} };
  }
  return {
    systemPrompt: builderPrompt,
    tools: BUILDER_TOOLS,
    allowedTools: parts.webSearch ? [TOOL_NAME] : [],
    mcpServers: parts.webSearch ? { [SERVER_NAME]: parts.webSearch } : {},
    agents: builderAgents(config, parts.webSearch !== undefined),
  };
}

export function queryOptions(config: Config, parts: OptionParts): Options {
  return {
    cwd: config.workspace,
    model: config.model,
    ...roleOptions(config, parts),
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
