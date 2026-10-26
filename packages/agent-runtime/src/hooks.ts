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

/** `git`, then any global options (-C dir, -c key=value, --flag), before the subcommand. */
const GIT = String.raw`\bgit(?:\s+(?:-[Cc]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+`;

/** Shell commands the orchestrator does instead of the agent. */
const DENIED_COMMANDS: { pattern: RegExp; reason: string }[] = [
  {
    pattern: new RegExp(`${GIT}push\\b`),
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

/** The only file the reviewer may write. */
const REVIEW_FILE = 'review.json';

const READ_ONLY_REASON = `The reviewer reads and writes only ${REVIEW_FILE}: do not change files, commit or install. Write the review with the Write tool.`;

/** Where a shell command begins: the start, after a separator or pipe, in a subshell, or after xargs. */
const COMMAND_START = String.raw`(?:^|[\n;&|(\`]|\$\()\s*(?:(?:xargs|sudo|env)(?:\s+-\S+)*\s+)?`;

/**
 * Shell commands that change the repository, the workspace or the toolchain,
 * which a reviewer has no use for, and the wrappers that would run one from
 * inside quotes. Matched against the command with quoted text removed, so a
 * search for `git commit` is not a commit.
 */
const REVIEWER_DENIED_COMMANDS: RegExp[] = [
  new RegExp(`${GIT}(?:commit|checkout|switch|reset|restore|stash|add|rm|mv|apply|am|rebase|merge|cherry-pick|revert|clean)\\b`),
  /\b(?:npm|npx|pnpm|yarn|pip|pip3)\s+(?:install|i|ci|add|uninstall|remove)\b/,
  new RegExp(`${COMMAND_START}(?:tee|rm|mv|cp|touch|mkdir|rmdir|ln|chmod|chown|truncate|dd)(?:\\s|$)`),
  new RegExp(`${COMMAND_START}sed\\s+(?:-\\w*\\s+)*-i`),
  /\b(?:(?:ba|z)?sh\s+-c|eval|python3?\s+-c|node\s+-e)\b/,
];

/** The command with quoted text emptied. */
function unquoted(command: string): string {
  return command.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * Whether a command redirects output to a file. Quoted text is ignored, so a
 * search for `=>` is not a write, and so are redirections to /dev/null or
 * between standard streams.
 */
export function writesByRedirection(command: string): boolean {
  const harmless = unquoted(command).replace(/\d*>>?\s*\/dev\/null\b/g, '').replace(/\d*>&\d\b/g, '');
  return harmless.includes('>');
}

/**
 * The reviewer's rules (the role is advisory and nothing but review.json
 * leaves its session): file tools write only /workspace/review.json, and the
 * shell may not write files, change git state or install. Like the builder's
 * rules, these narrow what a prompt injection in the change under review can
 * drive; CollectReview, reading one file and validating it, is the gate.
 */
export function decideReviewerToolUse(workspace: string, toolName: string, input: unknown): Decision {
  const fields = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;

  const field = FILE_TOOLS[toolName];
  if (field) {
    const raw = fields[field];
    const target = typeof raw === 'string' && raw.length > 0 ? path.resolve(workspace, raw) : undefined;
    if (toolName === 'NotebookEdit' || target !== path.join(workspace, REVIEW_FILE)) return { allow: false, reason: READ_ONLY_REASON };
  }

  if (toolName === 'Bash') {
    const command = typeof fields.command === 'string' ? fields.command : '';
    for (const { pattern, reason } of DENIED_COMMANDS) {
      if (pattern.test(command)) return { allow: false, reason };
    }
    if (writesByRedirection(command) || REVIEWER_DENIED_COMMANDS.some((pattern) => pattern.test(unquoted(command)))) {
      return { allow: false, reason: READ_ONLY_REASON };
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

type Decide = (toolName: string, input: unknown, agentType: string | undefined) => Decision;

function decisionHooks(decide: Decide, onDenied: (toolName: string, reason: string) => void): HookCallbackMatcher[] {
  return [
    {
      hooks: [
        async (input: HookInput) => {
          if (input.hook_event_name !== 'PreToolUse') return {};
          const decision = decide(input.tool_name, input.tool_input, input.agent_id === undefined ? undefined : input.agent_type);
          if (!decision.allow) onDenied(input.tool_name, decision.reason);
          return toHookOutput(decision);
        },
      ],
    },
  ];
}

/**
 * The builder's PreToolUse hook. `planGateClosed` is the plan hook's verdict
 * (report.ts): once the plan has been invalid twice, every tool call is
 * denied, so the run ends as a finished one and Collect reports the invalid
 * plan.
 */
export function preToolUseHooks(
  workspace: string,
  onDenied: (toolName: string, reason: string) => void,
  planGateClosed: () => boolean = () => false,
): HookCallbackMatcher[] {
  return decisionHooks(
    (toolName, input, agentType) =>
      planGateClosed() ? { allow: false, reason: PLAN_GATE_CLOSED } : decideToolUse(workspace, toolName, input, agentType),
    onDenied,
  );
}

/** The reviewer's PreToolUse hook. */
export function reviewerPreToolUseHooks(workspace: string, onDenied: (toolName: string, reason: string) => void): HookCallbackMatcher[] {
  return decisionHooks((toolName, input) => decideReviewerToolUse(workspace, toolName, input), onDenied);
}
