/**
 * In-session tool rules, applied by a PreToolUse hook in the host process. They
 * constrain what a prompt injection can drive; they are not the access gate
 * (docs/security.md section 9). The gates are outside the session: the
 * execution role, the bundle and clean room, and the trusted test workflow.
 */
import path from 'node:path';

import type { HookCallbackMatcher, HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

export type Decision = { allow: true } | { allow: false; reason: string };

/** Host-owned state inside the workspace: the run's record and the SDK's own files. */
const HOST_DIRECTORIES = ['.factorial', '.claude'];

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

function isInside(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function decideToolUse(workspace: string, toolName: string, input: unknown): Decision {
  const fields = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;

  const field = FILE_TOOLS[toolName];
  if (field) {
    const raw = fields[field];
    if (typeof raw !== 'string' || raw.length === 0) {
      return { allow: false, reason: `${toolName} needs an absolute path in ${field}.` };
    }
    const target = path.resolve(workspace, raw);
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

export function preToolUseHooks(
  workspace: string,
  onDenied: (toolName: string, reason: string) => void,
): HookCallbackMatcher[] {
  return [
    {
      hooks: [
        async (input: HookInput) => {
          if (input.hook_event_name !== 'PreToolUse') return {};
          const decision = decideToolUse(workspace, input.tool_name, input.tool_input);
          if (!decision.allow) onDenied(input.tool_name, decision.reason);
          return toHookOutput(decision);
        },
      ],
    },
  ];
}
