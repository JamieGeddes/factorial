/**
 * A role's policy (../roles.ts) as the Claude Agent SDK's hooks, which run in
 * the host process, out of the model's reach: PreToolUse asks the policy
 * before each tool call, PostToolUse after each Write or Edit, and Stop
 * before the run may end. A hook that blocks sends the model the policy's
 * reason.
 */
import type { HookCallbackMatcher, HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

import type { Note, RolePolicy } from '../roles.ts';
import type { Decision } from '../tool-rules.ts';
import { CLAUDE_TOOLS, toolCallOf } from './tools.ts';

export interface SdkHooks {
  preToolUse: HookCallbackMatcher[];
  postToolUse: HookCallbackMatcher[];
  stop: HookCallbackMatcher[];
}

export function toHookOutput(decision: Decision): SyncHookJSONOutput {
  if (decision.allow) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: decision.reason,
    },
  };
}

const block = (reason: string | undefined): SyncHookJSONOutput => (reason === undefined ? {} : { decision: 'block', reason });

export function sdkHooks(policy: RolePolicy, note: Note): SdkHooks {
  const preToolUse: HookCallbackMatcher[] = [
    {
      hooks: [
        async (input: HookInput) => {
          if (input.hook_event_name !== 'PreToolUse') return {};
          // agent_type is set on a subagent's calls only when agent_id is.
          const decision = policy.decide(toolCallOf(input.tool_name, input.tool_input), input.agent_id === undefined ? undefined : input.agent_type);
          if (!decision.allow) note('tool use denied', { toolName: input.tool_name, reason: decision.reason });
          return toHookOutput(decision);
        },
      ],
    },
  ];
  const { afterFileChange } = policy;
  const postToolUse: HookCallbackMatcher[] = afterFileChange
    ? [
        {
          matcher: `${CLAUDE_TOOLS.write}|${CLAUDE_TOOLS.edit}`,
          hooks: [
            async (input: HookInput) => {
              if (input.hook_event_name !== 'PostToolUse') return {};
              const call = toolCallOf(input.tool_name, input.tool_input);
              return call.kind === 'write' || call.kind === 'edit' ? block(call.path ? afterFileChange(call.path) : undefined) : {};
            },
          ],
        },
      ]
    : [];
  const stop: HookCallbackMatcher[] = [
    {
      hooks: [async (input: HookInput) => (input.hook_event_name === 'Stop' ? block(policy.beforeStop()) : {})],
    },
  ];
  return { preToolUse, postToolUse, stop };
}
