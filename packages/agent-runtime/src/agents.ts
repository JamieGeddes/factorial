/**
 * Subagents the builder may start. Defined in code and passed to the SDK, with
 * the built-in agents turned off (CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS), so
 * these are the only ones that exist. Subagents share the builder's session and
 * trust level, and their reports are the model's claim, never evidence.
 */
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];

export const explore: AgentDefinition = {
  description:
    'Read-only codebase search. Use it to answer a specific question about the repository (where something is defined, which files follow a pattern, how a convention is applied) without filling your own context with file contents.',
  prompt: [
    "You are a read-only search agent inside Factorial's builder session.",
    'Answer the question you are given about the repository at /workspace/repo, using Read, Grep and Glob only.',
    'Read selectively: search first, then read only the line ranges that answer the question.',
    'Reply with the answer, the file paths and line numbers it rests on, and nothing else. Do not propose changes.',
  ].join('\n'),
  tools: READ_ONLY_TOOLS,
  maxTurns: 30,
};

export const builderAgents: Record<string, AgentDefinition> = { explore };
