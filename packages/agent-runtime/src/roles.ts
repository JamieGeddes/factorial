/**
 * The host's part of each role (#164): its system prompt, tools, subagents
 * and hooks. What the host, the invoker and the orchestrator share is the
 * role's manifest in @factorial/roles; these parts are only the host's,
 * because only the host's copy is fixed on the Runtime version. A role named
 * in @factorial/roles without an entry here fails the typecheck.
 */
import path from 'node:path';

import type { AgentDefinition, HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import type { RoleName } from '@factorial/roles';

import { builderAgents } from './agents.ts';
import type { Config } from './config.ts';
import { preToolUseHooks, reviewerPreToolUseHooks } from './hooks.ts';
import { builderPrompt } from './prompts/builder.ts';
import { reviewerPrompt } from './prompts/reviewer.ts';
import { planBrief, planHooks, readAgentFile, stopHooks, type PlanGate } from './report.ts';
import { reviewStopHooks } from './review.ts';

/** Logs a line on the run's log. */
export type Note = (message: string, fields: Record<string, unknown>) => void;

/** One run's hooks, and the prompt it starts with. */
export interface RoleSession {
  preToolUse: HookCallbackMatcher[];
  postToolUse: HookCallbackMatcher[];
  stop: HookCallbackMatcher[];
  /** The first message, from the request's prompt. */
  prompt(requestPrompt: string): string;
}

export interface HostRole {
  systemPrompt: string;
  tools: readonly string[];
  /** Whether the role is offered web search when the Runtime version names a gateway. */
  webSearch: boolean;
  /** The role's subagents; `webSearch` says whether the gateway is offered. */
  agents(config: Config, webSearch: boolean): Record<string, AgentDefinition>;
  /** Hooks hold a run's state (the plan gate, the checks made), so each run gets its own. */
  session(workspace: string, note: Note): RoleSession;
}

/** The built-in tools the builder may use. `WebFetch` reads a page through the Claude Code subprocess (no permission rule: bypassPermissions skips its prompt; never add an `ask` rule). `Agent` starts the subagents in agents.ts (explore and plan). */
export const BUILDER_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch', 'Agent'];

/** The reviewer's: it reads, and its PreToolUse hook lets Write and Edit reach only /workspace/review.json. No subagents and no web search: everything it judges is in the session. */
export const REVIEWER_TOOLS = ['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit'];

const denied = (note: Note) => (toolName: string, reason: string) => note('tool use denied', { toolName, reason });

const builder: HostRole = {
  systemPrompt: builderPrompt,
  tools: BUILDER_TOOLS,
  webSearch: true,
  agents: builderAgents,
  session(workspace, note) {
    const planGate: PlanGate = { closed: false };
    return {
      preToolUse: preToolUseHooks(workspace, denied(note), () => planGate.closed),
      postToolUse: planHooks(workspace, planGate, (errors, closed) => note(closed ? 'plan invalid again; tools closed' : 'plan invalid; builder sent back', { errors })),
      stop: stopHooks(workspace, planGate, (reason) => note('report incomplete; builder sent back', { reason })),
      // A later round starts with the plan's steps in full.
      prompt(requestPrompt) {
        const brief = planBrief(readAgentFile(path.join(workspace, 'plan.json')));
        return brief ? `${requestPrompt}\n\n${brief}` : requestPrompt;
      },
    };
  },
};

const reviewer: HostRole = {
  systemPrompt: reviewerPrompt,
  tools: REVIEWER_TOOLS,
  webSearch: false,
  agents: () => ({}),
  session(workspace, note) {
    return {
      preToolUse: reviewerPreToolUseHooks(workspace, denied(note)),
      postToolUse: [],
      stop: reviewStopHooks(workspace, (reason) => note('reviewer sent back', { reason })),
      prompt: (requestPrompt) => requestPrompt,
    };
  },
};

export const HOST_ROLES: Readonly<Record<RoleName, HostRole>> = { builder, reviewer };
