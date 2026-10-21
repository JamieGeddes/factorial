/**
 * Which agent role this task runs. One task definition serves every role:
 * the state machine passes the role and its harness in the container
 * overrides, and this checks they belong together before anything is invoked.
 */
import type { WorkItem } from '@factorial/workitem';

import { buildPrompt, planPrompt, reviewPrompt } from './prompt.ts';

/** Roles the invoker knows how to start; each has a harness `factorial_<role>`. */
export const ROLES = ['builder', 'planner', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

/** Where a role's run is recorded: its artefact folder, log stage and ledger statuses. */
export interface RoleStage {
  /** The artefact folder under the attempt's prefix, and the log stage. */
  stage: 'build' | 'plan' | 'review';
  running: string;
  done: string;
  failed: string;
}

export const ROLE_STAGES: Record<Role, RoleStage> = {
  builder: { stage: 'build', running: 'building', done: 'built', failed: 'build-error' },
  planner: { stage: 'plan', running: 'planning', done: 'planned', failed: 'plan-error' },
  reviewer: { stage: 'review', running: 'reviewing', done: 'review-done', failed: 'review-error' },
};

export interface RunOutcome {
  stopReason: string | undefined;
  toolCalls: number;
  durationSeconds: number;
  usage: unknown;
  error: string | undefined;
  /** Pointers to the stored transcript and usage, when they were stored. */
  record: Record<string, unknown> | undefined;
}

/**
 * The ledger attributes for a finished run. The builder's keep their
 * existing top-level names; other roles' sit under their stage, until the
 * progress record (#15) gives every stage the same shape.
 */
export function outcomeAttributes(role: Role, outcome: RunOutcome): Record<string, unknown> {
  if (role === 'builder') {
    return {
      stopReason: outcome.stopReason,
      toolCalls: outcome.toolCalls,
      buildDurationSeconds: outcome.durationSeconds,
      usage: outcome.usage,
      buildError: outcome.error,
      build: outcome.record,
    };
  }
  return {
    [ROLE_STAGES[role].stage]: {
      stopReason: outcome.stopReason,
      toolCalls: outcome.toolCalls,
      durationSeconds: outcome.durationSeconds,
      usage: outcome.usage,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...outcome.record,
    },
  };
}

export interface HarnessTarget {
  role: Role;
  harnessArn: string;
  harnessId: string;
  /** The endpoint invoked, `live` in normal running. */
  qualifier: string;
}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Read and check the role and harness from the task's environment. */
export function harnessTarget(env: Record<string, string | undefined>): HarnessTarget {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
  };
  const role = required('ROLE');
  if (!isRole(role)) throw new Error(`Unknown agent role "${role}"`);
  const harnessId = required('HARNESS_ID');
  if (!new RegExp(`^factorial_${role}-[A-Za-z0-9]+$`).test(harnessId)) {
    throw new Error(`Harness ${harnessId} is not the ${role} harness`);
  }
  const harnessArn = required('HARNESS_ARN');
  if (!/^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:[0-9]{12}:harness\//.test(harnessArn) || !harnessArn.endsWith(`:harness/${harnessId}`)) {
    throw new Error(`HARNESS_ARN does not name harness ${harnessId}`);
  }
  const qualifier = required('HARNESS_QUALIFIER');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(qualifier)) throw new Error(`"${qualifier}" is not an endpoint name`);
  return { role, harnessArn, harnessId, qualifier };
}

/** What a role's prompt needs beyond the work item: the planner's attempt, the reviewer's sensitive paths. */
export interface PromptOptions {
  planAttempt?: number;
  sensitivePaths?: string[];
}

/** The user message that starts a session for the role. */
export function promptFor(role: Role, workItem: WorkItem, branch: string, baseBranch: string, options: PromptOptions = {}): string {
  switch (role) {
    case 'builder':
      return buildPrompt(workItem, branch, baseBranch);
    case 'planner':
      return planPrompt(workItem, branch, baseBranch, options.planAttempt ?? 1);
    case 'reviewer':
      return reviewPrompt(workItem, branch, baseBranch, options.sensitivePaths ?? []);
  }
}

/**
 * The sensitive paths PrepareReview found, passed as a JSON array of
 * repository-relative paths. Anything else is refused rather than put into
 * the prompt.
 */
export function parseSensitivePaths(value: string | undefined): string[] {
  if (value === undefined || value === '') return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length > 20) throw new Error('SENSITIVE_PATHS is not a list of at most 20 paths');
  return parsed.map((path) => {
    if (typeof path !== 'string' || !/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\0\n`]{1,500}$/.test(path)) {
      throw new Error('SENSITIVE_PATHS holds a value that is not a repository path');
    }
    return path;
  });
}
