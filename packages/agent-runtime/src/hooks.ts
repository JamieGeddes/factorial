/**
 * In-session tool rules, applied by a PreToolUse hook in the host process. They
 * constrain what a prompt injection can drive; they are not the access gate
 * (docs/security.md section 9). The gates are outside the session: the
 * execution role, the bundle and clean room, and the trusted test workflow.
 */
import path from 'node:path';

import type { HookCallbackMatcher, HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

import { PLAN_AGENT } from './agents.ts';
import { PLAN_GATE_CLOSED } from './report.ts';

export type Decision = { allow: true } | { allow: false; reason: string };

/** The SDK's own files inside the workspace (CLAUDE_CONFIG_DIR). */
const HOST_DIRECTORIES = ['.claude'];

/** File tools and the input field that names their target. */
const FILE_TOOLS: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** Shell commands the orchestrator does instead of the agent. */
const DENIED_COMMANDS: { pattern: RegExp; reason: string }[] = [
  {
    // push as git's subcommand, after any global options (-C dir, -c key=value, --flag).
    pattern: /\bgit(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+push\b/,
    reason: 'Do not push. The orchestrator pushes your commits after the session ends.',
  },
  {
    pattern: /\bgh\s+(auth|api)\b/,
    reason: 'Do not call GitHub. The orchestrator does all GitHub access; the session holds no GitHub credentials.',
  },
];

/** The only files the plan subagent may write. */
const PLAN_FILES = ['plan.json', 'plan.md'];

function isInside(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * `agentType` is the subagent making the call, absent for the builder. The
 * plan subagent may write only the two plan files.
 */
export function decideToolUse(workspace: string, toolName: string, input: unknown, agentType?: string): Decision {
  const fields = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;

  const field = FILE_TOOLS[toolName];
  if (field) {
    const raw = fields[field];
    if (typeof raw !== 'string' || raw.length === 0) {
      return { allow: false, reason: `${toolName} needs an absolute path in ${field}.` };
    }
    const target = path.resolve(workspace, raw);
    if (agentType === PLAN_AGENT && (toolName !== 'Write' || !PLAN_FILES.some((file) => target === path.join(workspace, file)))) {
      return { allow: false, reason: `The plan subagent writes only ${PLAN_FILES.map((file) => path.join(workspace, file)).join(' and ')}.` };
    }
    if (!isInside(workspace, target)) {
      return { allow: false, reason: `Write only inside ${workspace}; ${target} is outside it.` };
    }
    for (const directory of HOST_DIRECTORIES) {
      if (isInside(path.join(workspace, directory), target)) {
        return { allow: false, reason: `${path.join(workspace, directory)} belongs to the host process; do not write there.` };
      }
    }
  }

  if (toolName === 'Bash') {
    const command = typeof fields.command === 'string' ? fields.command : '';
    for (const { pattern, reason } of DENIED_COMMANDS) {
      if (pattern.test(command)) return { allow: false, reason };
    }
  }

  return { allow: true };
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

/**
 * `planGateClosed` is the plan hook's verdict (report.ts): once the plan has
 * been invalid twice, every tool call is denied, so the run ends as a
 * finished one and Collect reports the invalid plan.
 */
export function preToolUseHooks(
  workspace: string,
  onDenied: (toolName: string, reason: string) => void,
  planGateClosed: () => boolean = () => false,
): HookCallbackMatcher[] {
  return [
    {
      hooks: [
        async (input: HookInput) => {
          if (input.hook_event_name !== 'PreToolUse') return {};
          const decision: Decision = planGateClosed()
            ? { allow: false, reason: PLAN_GATE_CLOSED }
            : decideToolUse(workspace, input.tool_name, input.tool_input, input.agent_id === undefined ? undefined : input.agent_type);
          if (!decision.allow) onDenied(input.tool_name, decision.reason);
          return toHookOutput(decision);
        },
      ],
    },
  ];
}
