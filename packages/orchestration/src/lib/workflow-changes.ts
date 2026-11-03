/**
 * The opt-in for changes to GitHub Actions (#296).
 *
 * CI runs an edited workflow on the pull request with the repository's
 * secrets, so a change under `.github/workflows/` or `.github/actions/` is
 * refused unless the target allows it in `.factorial/workflow-changes.json`.
 * Collect reads that file from the target's base branch, never from the
 * branch under review, so the builder cannot grant itself the permission.
 * Default deny: a missing, oversized, unparseable or invalid file refuses.
 */
import type { ReadFile } from './verify.ts';

export const WORKFLOW_SETTINGS_FILE = '.factorial/workflow-changes.json';
export const MAX_WORKFLOW_SETTINGS_BYTES = 16 * 1024;
/** At most this many refused paths are reported on the issue. */
export const REFUSED_PATHS_SHOWN = 10;
/** At most this many refused paths are carried in the error. */
const MAX_PATHS_IN_ERROR = 20;

const GUARDED_PREFIXES = ['.github/workflows/', '.github/actions/'];

/**
 * The changed paths under a guarded prefix. Git quotes names with tabs,
 * newlines, quotes or backslashes (`"..."`), so one leading quote is
 * tolerated: a quoted name must not slip past the guard.
 */
export function workflowPaths(changedPaths: readonly string[]): string[] {
  return changedPaths.filter((path) => {
    const bare = path.startsWith('"') ? path.slice(1) : path;
    return GUARDED_PREFIXES.some((prefix) => bare.startsWith(prefix));
  });
}

export interface WorkflowSettings {
  allowed: boolean;
  /** Why a file that is there does not allow the change. */
  problem?: string;
}

/** Fail closed: anything but `allowWorkflowChanges: true` in a valid v1 file denies. Unknown keys are ignored. */
export function parseWorkflowSettings(text: string): WorkflowSettings {
  if (Buffer.byteLength(text) > MAX_WORKFLOW_SETTINGS_BYTES) return { allowed: false, problem: `${WORKFLOW_SETTINGS_FILE} is larger than ${MAX_WORKFLOW_SETTINGS_BYTES} bytes` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { allowed: false, problem: `${WORKFLOW_SETTINGS_FILE} is not valid JSON` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { allowed: false, problem: `${WORKFLOW_SETTINGS_FILE} is not a JSON object` };
  }
  const settings = parsed as { schemaVersion?: unknown; allowWorkflowChanges?: unknown };
  if (settings.schemaVersion !== 1) return { allowed: false, problem: `${WORKFLOW_SETTINGS_FILE}: schemaVersion must be 1` };
  if (typeof settings.allowWorkflowChanges !== 'boolean') {
    return { allowed: false, problem: `${WORKFLOW_SETTINGS_FILE}: allowWorkflowChanges must be true or false` };
  }
  return { allowed: settings.allowWorkflowChanges };
}

/** Whether the target's base branch allows a workflow change. A read error propagates: it never allows. */
export async function workflowChangeAllowed(repo: { owner: string; name: string }, baseBranch: string, read: ReadFile): Promise<WorkflowSettings> {
  const text = await read(repo, WORKFLOW_SETTINGS_FILE, baseBranch, MAX_WORKFLOW_SETTINGS_BYTES + 1);
  if (text === undefined) return { allowed: false };
  return parseWorkflowSettings(text);
}

/** The change edits workflows or actions and the target has not opted in: nothing is pushed. */
export class WorkflowChangeRefusedError extends Error {
  constructor(paths: readonly string[]) {
    const shown = paths.slice(0, MAX_PATHS_IN_ERROR);
    const more = paths.length - shown.length;
    super(
      `The change edits GitHub Actions workflows or actions and the target has not opted in:\n${shown.map((p) => `- ${p}`).join('\n')}${more > 0 ? `\n- and ${more} more` : ''}`,
    );
    this.name = 'WorkflowChangeRefused';
  }
}

/** The refused paths from a WorkflowChangeRefused failure's cause (a Lambda error object as JSON); [] when unreadable. */
export function workflowPathsOf(cause: string | undefined): string[] {
  try {
    const message: unknown = (JSON.parse(cause ?? '') as { errorMessage?: unknown }).errorMessage;
    if (typeof message !== 'string') return [];
    return message
      .split('\n')
      .filter((line) => line.startsWith('- ') && !/^- and \d+ more$/.test(line))
      .map((line) => line.slice(2));
  } catch {
    return [];
  }
}

/** How many paths the error left out, from the cause; 0 when none or unreadable. */
export function workflowPathsOmitted(cause: string | undefined): number {
  try {
    const message: unknown = (JSON.parse(cause ?? '') as { errorMessage?: unknown }).errorMessage;
    const match = typeof message === 'string' ? /^- and (\d+) more$/m.exec(message) : null;
    return match?.[1] ? Number.parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}
