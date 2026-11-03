/**
 * The builder's policy on the propose route (#169). The orchestrator seeds
 * /workspace/route.json; the host reads it once as the run starts, before
 * the model has run, so nothing the model writes changes the run's route.
 *
 * A proposal plans and changes nothing. Until the plan is written, file
 * tools may write only in the workspace outside the repository (the plan
 * files and notes.md), and the builder's shell is read-only, as the
 * reviewer's is. Once plan.json is valid and plan.md is written, every tool
 * closes and the model is told to end the run. Collect is still the gate:
 * it fails a proposal whose repository changed, and pushes nothing.
 */
import path from 'node:path';

import { ROUTE_FILE, parseRouteFile, type SessionRoute } from '@factorial/roles';

import { MAX_REPORT_CHECKS, planErrors, planInstruction, readAgentFile } from './report.ts';
import { unquoted, withoutHeredocBodies } from './shell-text.ts';
import { REVIEWER_DENIED_COMMANDS, writesByRedirection } from './tool-rules.ts';
import type { ToolCall } from './tools.ts';

export const PROPOSAL_DONE =
  'The plan is written and valid, and this run is a proposal: nothing more is done in this session. Make no more tool calls: end the session now with a one-line reply.';

export const PROPOSAL_READ_ONLY =
  'This run is a proposal: change nothing in the repository. Write only /workspace/plan.json and /workspace/plan.md (with the plan subagent) and /workspace/notes.md, and use the shell only to read.';

/** The route the run was seeded with, read before the model runs. */
export function seededRoute(workspace: string): SessionRoute {
  return parseRouteFile(readAgentFile(path.join(workspace, ROUTE_FILE), 1024));
}

function isInside(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Why a tool call is refused on the propose route before the plan is done, or undefined. Applied after the builder's own rules. */
export function proposalRule(dirs: { workspace: string; repository: string }, call: ToolCall): string | undefined {
  if (call.kind === 'write' || call.kind === 'edit') {
    const target = path.resolve(dirs.workspace, call.path ?? '');
    return isInside(dirs.repository, target) || target === path.join(dirs.workspace, ROUTE_FILE) ? PROPOSAL_READ_ONLY : undefined;
  }
  if (call.kind === 'shell') {
    const text = unquoted(withoutHeredocBodies(call.command));
    if (writesByRedirection(call.command) || REVIEWER_DENIED_COMMANDS.some((pattern) => pattern.test(text))) return PROPOSAL_READ_ONLY;
  }
  return undefined;
}

/** Whether the proposal is done: plan.json valid and plan.md written. */
export function proposalDone(workspace: string): boolean {
  const markdown = readAgentFile(path.join(workspace, 'plan.md'));
  return markdown !== undefined && markdown.trim() !== '' && planErrors(readAgentFile(path.join(workspace, 'plan.json'))) === undefined;
}

/** The stop check on the propose route: send the builder back while the plan is missing or invalid, at most MAX_REPORT_CHECKS times. No summary is asked for. */
export function proposalStopCheck(workspace: string, onBlocked: (reason: string) => void): () => string | undefined {
  let checks = 0;
  return () => {
    if (checks >= MAX_REPORT_CHECKS || proposalDone(workspace)) return undefined;
    const errors = planErrors(readAgentFile(path.join(workspace, 'plan.json')));
    const reason = errors
      ? planInstruction(errors)
      : '/workspace/plan.md is missing or empty. Have the plan subagent write it beside /workspace/plan.json, then end the session.';
    checks += 1;
    onBlocked(reason);
    return reason;
  };
}
