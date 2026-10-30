/**
 * In-session tool rules, applied before each tool call by the harness's hook
 * in the host process (pi's host extension, pi/harness.ts). They constrain what a prompt
 * injection can drive; they are not the access gate (docs/security.md
 * section 9). The gates are outside the session: the execution role, the
 * bundle and clean room, and the trusted test workflow. They judge a ToolCall
 * (tools.ts), so they hold for every harness.
 */
import path from 'node:path';

import { PLAN_AGENT } from './agents.ts';
import type { ToolCall } from './tools.ts';

export type Decision = { allow: true } | { allow: false; reason: string };

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

function deniedCommand(command: string): Decision | undefined {
  for (const { pattern, reason } of DENIED_COMMANDS) {
    if (pattern.test(command)) return { allow: false, reason };
  }
  return undefined;
}

/**
 * `agentType` is the subagent making the call, absent for the builder. The
 * plan subagent may write only the two plan files.
 */
export function decideToolUse(workspace: string, call: ToolCall, agentType?: string): Decision {
  if (call.kind === 'write' || call.kind === 'edit') {
    if (call.path === undefined || call.path.length === 0) return { allow: false, reason: 'Give the file tool the path of the file to change.' };
    const target = path.resolve(workspace, call.path);
    if (agentType === PLAN_AGENT && (call.kind !== 'write' || !PLAN_FILES.some((file) => target === path.join(workspace, file)))) {
      return { allow: false, reason: `The plan subagent writes only ${PLAN_FILES.map((file) => path.join(workspace, file)).join(' and ')}.` };
    }
    if (!isInside(workspace, target)) {
      return { allow: false, reason: `Write only inside ${workspace}; ${target} is outside it.` };
    }
  }

  if (call.kind === 'shell') return deniedCommand(call.command) ?? { allow: true };

  return { allow: true };
}

/** The only file the reviewer may write. */
const REVIEW_FILE = 'review.json';

/** `writeTool` is what the harness calls its file-writing tool. */
const readOnlyReason = (writeTool: string) =>
  `The reviewer reads and writes only ${REVIEW_FILE}: do not change files, commit or install. Write the review with the ${writeTool} tool.`;

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
export function decideReviewerToolUse(workspace: string, call: ToolCall, writeTool: string): Decision {
  if (call.kind === 'write' || call.kind === 'edit') {
    const target = call.path ? path.resolve(workspace, call.path) : undefined;
    if (target !== path.join(workspace, REVIEW_FILE)) return { allow: false, reason: readOnlyReason(writeTool) };
  }

  if (call.kind === 'shell') {
    const denied = deniedCommand(call.command);
    if (denied) return denied;
    if (writesByRedirection(call.command) || REVIEWER_DENIED_COMMANDS.some((pattern) => pattern.test(unquoted(call.command)))) {
      return { allow: false, reason: readOnlyReason(writeTool) };
    }
  }

  return { allow: true };
}
