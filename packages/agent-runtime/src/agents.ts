/**
 * Subagents the builder may start. Defined in code and passed to the SDK, with
 * the built-in agents turned off (CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS), so
 * these are the only ones that exist. Subagents share the builder's session and
 * trust level, and their reports are the model's claim, never evidence.
 */
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

import type { Config } from './config.ts';
import { planPrompt } from './prompts/plan.ts';
import { TOOL_NAME } from './web-search.ts';

export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

export function explore(config: Config): AgentDefinition {
  return {
    description:
      'Read-only codebase search. Use it to answer a specific question about the repository (where something is defined, which files follow a pattern, how a convention is applied) without filling your own context with file contents.',
    prompt: [
      "You are a read-only search agent inside Factorial's builder session.",
      'Answer the question you are given about the repository at /workspace/repo, using Read, Grep and Glob only.',
      'Read selectively: search first, then read only the line ranges that answer the question.',
      'Reply with the answer, the file paths and line numbers it rests on, and nothing else. Do not propose changes.',
    ].join('\n'),
    tools: READ_ONLY_TOOLS,
    // The full inference profile id from the Runtime version, not an alias.
    model: config.exploreModel,
    maxTurns: 30,
  };
}

/** The plan subagent's name, which hooks see as `agent_type` on its tool calls. */
export const PLAN_AGENT = 'plan';

/**
 * The planner, inside the builder's session since phase 3.1 of
 * docs/agent-sdk-plan.md, on the builder's own model: planning is where the
 * reasoning pays. It reads, searches the web like the planner harness did,
 * reads the pages it finds (WebFetch, as the builder does), and writes the
 * two plan files itself: the PreToolUse hook (hooks.ts) lets
 * it write nothing else, and the plan hook (report.ts) sends it the
 * validation errors, so the planner fixes its own plan.
 */
export function plan(webSearch: boolean): AgentDefinition {
  return {
    description:
      'Planner. Run it once, before any change, with the request and anything already on the branch; it writes /workspace/plan.json and /workspace/plan.md and replies with a short summary.',
    prompt: planPrompt,
    tools: [...READ_ONLY_TOOLS, 'Write', 'WebFetch', ...(webSearch ? [TOOL_NAME] : [])],
    model: 'inherit',
    maxTurns: 40,
  };
}

export function builderAgents(config: Config, webSearch: boolean): Record<string, AgentDefinition> {
  return { explore: explore(config), [PLAN_AGENT]: plan(webSearch) };
}
