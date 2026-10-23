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

/**
 * The exit code for a builder that stopped before finishing: the ECS task
 * fails, so the state machine saves the work and reports it instead of
 * testing it and opening a pull request. Report recognises the code.
 */
export const INCOMPLETE_EXIT_CODE = 3;

/**
 * Why a run that ended without an error is still incomplete, or undefined
 * if it is complete. Only the builder's run is judged here: a half-finished
 * build must not become a pull request, while CollectPlan and CollectReview
 * already check what the planner and the reviewer left behind.
 */
export function incompleteReason(role: Role, stopReason: string | undefined): string | undefined {
  // end_turn is the harness's finished run; success is the Agent SDK's.
  if (role !== 'builder' || stopReason === 'end_turn' || stopReason === 'success') return undefined;
  return `incomplete: the builder stopped with ${stopReason ?? 'no stop reason'} before finishing`;
}

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

export interface RuntimeTarget {
  role: Role;
  runtimeArn: string;
  runtimeId: string;
  /** The endpoint invoked, `live` in normal running. */
  qualifier: string;
}

/** Which kind of agent the task invokes: a harness, or Factorial's host on an AgentCore Runtime. */
export type AgentTarget = ({ kind: 'harness' } & HarnessTarget) | ({ kind: 'runtime' } & RuntimeTarget);

/**
 * Read and check the target from the task's environment. TARGET is
 * `harness` (the default) or `runtime`; a runtime is named by RUNTIME_ARN and
 * RUNTIME_QUALIFIER, and must be the role's runtime, `factorial_<role>-…`.
 */
export function agentTarget(env: Record<string, string | undefined>): AgentTarget {
  const target = env.TARGET || 'harness';
  if (target === 'harness') return { kind: 'harness', ...harnessTarget(env) };
  if (target !== 'runtime') throw new Error(`Unknown target "${target}"`);
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
  };
  const role = required('ROLE');
  if (!isRole(role)) throw new Error(`Unknown agent role "${role}"`);
  const runtimeArn = required('RUNTIME_ARN');
  const match = /^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:[0-9]{12}:runtime\/([A-Za-z0-9_-]+)$/.exec(runtimeArn);
  const runtimeId = match?.[1];
  if (!runtimeId || !new RegExp(`^factorial_${role}-[A-Za-z0-9]+$`).test(runtimeId)) {
    throw new Error(`RUNTIME_ARN does not name the ${role} runtime`);
  }
  const qualifier = required('RUNTIME_QUALIFIER');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(qualifier)) throw new Error(`"${qualifier}" is not an endpoint name`);
  return { kind: 'runtime', role, runtimeArn, runtimeId, qualifier };
}

/** A changed file the orchestrator flagged for care, and why. */
export interface SensitivePath {
  path: string;
  reason: string;
}

/** What a role's prompt needs beyond the work item: the planner's attempt, the reviewer's sensitive paths. */
export interface PromptOptions {
  planAttempt?: number;
  sensitivePaths?: SensitivePath[];
  /** The builder's round: 2 or more when continuing a build in a fresh session. */
  buildRound?: number;
}

/** The user message that starts a session for the role. */
export function promptFor(role: Role, workItem: WorkItem, branch: string, baseBranch: string, options: PromptOptions = {}): string {
  switch (role) {
    case 'builder':
      return buildPrompt(workItem, branch, baseBranch, options.buildRound ?? 1);
    case 'planner':
      return planPrompt(workItem, branch, baseBranch, options.planAttempt ?? 1);
    case 'reviewer':
      return reviewPrompt(workItem, branch, baseBranch, options.sensitivePaths ?? []);
  }
}

/**
 * The sensitive paths PrepareReview found, passed as a JSON array of
 * `{ path, reason }`: repository-relative paths, and single-line reasons from
 * the built-in rules or the base branch's rules file. Anything else is
 * refused rather than put into the prompt.
 */
export function parseSensitivePaths(value: string | undefined): SensitivePath[] {
  if (value === undefined || value === '') return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length > 20) throw new Error('SENSITIVE_PATHS is not a list of at most 20 paths');
  return parsed.map((entry: unknown) => {
    const { path, reason } = (entry ?? {}) as { path?: unknown; reason?: unknown };
    if (typeof path !== 'string' || !/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[^\0\n`]{1,500}$/.test(path)) {
      throw new Error('SENSITIVE_PATHS holds a value that is not a repository path');
    }
    if (typeof reason !== 'string' || !/^[^\0\r\n`]{1,200}$/.test(reason)) throw new Error('SENSITIVE_PATHS holds a reason that is not one short line');
    return { path, reason };
  });
}
