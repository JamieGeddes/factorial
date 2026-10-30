/**
 * The host's part of each role (#164): its system prompt, tools, subagents
 * and policy. What the host, the invoker and the orchestrator share is the
 * role's manifest in @factorial/roles; these parts are only the host's,
 * because only the host's copy is fixed on the Runtime version. A role named
 * in @factorial/roles without an entry here fails the typecheck.
 *
 * Nothing here names a harness: tools are kinds (tools.ts), prompts take each
 * harness's tool names, and the policy judges neutral tool calls and returns
 * what to send the model. The harness maps them onto its own hooks (pi's
 * host extension, pi/harness.ts).
 */
import path from 'node:path';

import type { RoleName } from '@factorial/roles';

import { BUILDER_SUBAGENTS, type SubagentSpec } from './agents.ts';
import { builderPrompt } from './prompts/builder.ts';
import { reviewerPrompt } from './prompts/reviewer.ts';
import { PLAN_GATE_CLOSED, planBrief, planCheck, readAgentFile, reportStopCheck, type PlanGate } from './report.ts';
import { reviewStopCheck } from './review.ts';
import { decideReviewerToolUse, decideToolUse, type Decision } from './tool-rules.ts';
import type { ToolCall, ToolKind, ToolNames } from './tools.ts';

/** Logs a line on the run's log. */
export type Note = (message: string, fields: Record<string, unknown>) => void;

/** One run's policy. It holds the run's state (the plan gate, the checks made), so each run gets its own. */
export interface RolePolicy {
  /** Before each tool call. `agentType` is the subagent making it, absent for the role's own loop. */
  decide(call: ToolCall, agentType?: string): Decision;
  /** After a file write or edit: what to send the model, or undefined. Absent when the role checks no file. */
  afterFileChange?: (target: string) => string | undefined;
  /** When the model would end the run: what to send it back with, or undefined to let it end. */
  beforeStop(): string | undefined;
  /** The first message, from the request's prompt. */
  prompt(requestPrompt: string): string;
}

export interface HostRole {
  systemPrompt(tools: ToolNames): string;
  /** The tools the role's own loop is offered, in order. Web search is `webSearch` below, not a kind here. */
  tools: readonly ToolKind[];
  /** Whether the role is offered web search when the Runtime version names a gateway. */
  webSearch: boolean;
  subagents: Readonly<Record<string, SubagentSpec>>;
  /** `tools` is the harness's names, for the policy's messages. */
  session(workspace: string, note: Note, tools: ToolNames): RolePolicy;
}

/** The builder's tools. `fetch` reads a page (no permission rule: the harness must not prompt for it). `agent` starts the subagents in agents.ts (explore and plan). */
export const BUILDER_TOOLS: readonly ToolKind[] = ['shell', 'read', 'edit', 'write', 'grep', 'glob', 'fetch', 'agent'];

/** The reviewer's: it reads, and its policy lets file writes reach only /workspace/review.json. No subagents and no web search: everything it judges is in the session. */
export const REVIEWER_TOOLS: readonly ToolKind[] = ['shell', 'read', 'grep', 'glob', 'write', 'edit'];

const builder: HostRole = {
  systemPrompt: builderPrompt,
  tools: BUILDER_TOOLS,
  webSearch: true,
  subagents: BUILDER_SUBAGENTS,
  session(workspace, note) {
    const planGate: PlanGate = { closed: false };
    return {
      decide: (call, agentType) => (planGate.closed ? { allow: false, reason: PLAN_GATE_CLOSED } : decideToolUse(workspace, call, agentType)),
      afterFileChange: planCheck(workspace, planGate, (errors, closed) => note(closed ? 'plan invalid again; tools closed' : 'plan invalid; builder sent back', { errors })),
      beforeStop: reportStopCheck(workspace, planGate, (reason) => note('report incomplete; builder sent back', { reason })),
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
  subagents: {},
  session(workspace, note, tools) {
    return {
      decide: (call) => decideReviewerToolUse(workspace, call, tools.write),
      beforeStop: reviewStopCheck(workspace, (reason) => note('reviewer sent back', { reason })),
      prompt: (requestPrompt) => requestPrompt,
    };
  },
};

export const HOST_ROLES: Readonly<Record<RoleName, HostRole>> = { builder, reviewer };
