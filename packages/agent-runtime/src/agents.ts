/**
 * Subagents the builder may start, defined once for every harness. Each
 * harness turns a spec into its own subagent (pi's `task` tool starts a child
 * session from one), and these are the only ones that exist. Subagents share the builder's session and trust level,
 * and their reports are the model's claim, never evidence.
 */
import { planPrompt } from './prompts/plan.ts';
import type { ToolKind, ToolNames } from './tools.ts';

export interface SubagentSpec {
  description: string;
  prompt: (tools: ToolNames) => string;
  /** In this order. `webSearch` is dropped when the gateway is not configured. */
  tools: readonly ToolKind[];
  /** `inherit` runs on the role's main model; `explore` on the Runtime version's explore model. */
  model: 'inherit' | 'explore';
  maxTurns: number;
}

export const READ_ONLY_TOOLS: readonly ToolKind[] = ['read', 'grep', 'glob'];

/** Subagents that may run at once, on any harness; a call beyond it waits for one to finish. */
export const MAX_CONCURRENT_SUBAGENTS = 4;

export const EXPLORE: SubagentSpec = {
  description:
    'Read-only codebase search. Use it to answer a specific question about the repository (where something is defined, which files follow a pattern, how a convention is applied) without filling your own context with file contents.',
  prompt: (t) =>
    [
      "You are a read-only search agent inside Factorial's builder session.",
      `Answer the question you are given about the repository at /workspace/repo, using ${t.read}, ${t.grep} and ${t.glob} only.`,
      'Read selectively: search first, then read only the line ranges that answer the question.',
      'Reply with the answer, the file paths and line numbers it rests on, and nothing else. Do not propose changes.',
    ].join('\n'),
  tools: READ_ONLY_TOOLS,
  model: 'explore',
  maxTurns: 30,
};

/** The plan subagent's name, which the rules see as the agent type on its tool calls. */
export const PLAN_AGENT = 'plan';

/**
 * The planner, inside the builder's session since phase 3.1 of
 * docs/agent-sdk-plan.md, on the builder's own model: planning is where the
 * reasoning pays. It reads, searches the web like the planner harness did,
 * reads the pages it finds, and writes the two plan files itself: the rules
 * (tool-rules.ts) let it write nothing else, and the plan check (report.ts)
 * sends it the validation errors, so the planner fixes its own plan.
 */
export const PLAN: SubagentSpec = {
  description:
    'Planner. Run it once, before any change, with the request and anything already on the branch; it writes /workspace/plan.json and /workspace/plan.md and replies with a short summary.',
  prompt: planPrompt,
  tools: [...READ_ONLY_TOOLS, 'write', 'fetch', 'webSearch'],
  model: 'inherit',
  maxTurns: 40,
};

export const BUILDER_SUBAGENTS: Readonly<Record<string, SubagentSpec>> = { explore: EXPLORE, [PLAN_AGENT]: PLAN };
