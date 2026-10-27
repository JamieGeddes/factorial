/**
 * Which agent role this task runs. One task definition serves every role:
 * the state machine passes the role and its Runtime in the container
 * overrides, and this checks they belong together before anything is invoked.
 */
import { isRoleName, type RoleManifest, type RoleName, type SensitivePath } from '@factorial/roles';

/**
 * The exit code for a run of a role that must finish (the builder) that
 * stopped before finishing: the ECS task fails, so the state machine saves
 * the work and reports it instead of testing it and opening a pull request.
 * Report recognises the code.
 */
export const INCOMPLETE_EXIT_CODE = 3;

/**
 * Why a run that ended without an error is still incomplete, or undefined
 * if it is complete. Only a role that must finish is judged here (the
 * manifest's `mustFinish`): a half-finished build must not become a pull
 * request, while CollectReview already checks what the reviewer left behind.
 */
export function incompleteReason(role: RoleManifest, stopReason: string | undefined): string | undefined {
  if (!role.mustFinish || stopReason === 'success') return undefined;
  return `incomplete: the ${role.name} stopped with ${stopReason ?? 'no stop reason'} before finishing`;
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
 * The ledger attributes for a finished run. A role whose manifest says
 * `top-level` (the builder) keeps the names from before other roles; other
 * roles' sit under their stage, until the progress record (#15) gives every
 * stage the same shape.
 */
export function outcomeAttributes(role: RoleManifest, outcome: RunOutcome): Record<string, unknown> {
  const { stage } = role;
  if (role.ledger === 'top-level') {
    return {
      stopReason: outcome.stopReason,
      toolCalls: outcome.toolCalls,
      [`${stage}DurationSeconds`]: outcome.durationSeconds,
      usage: outcome.usage,
      [`${stage}Error`]: outcome.error,
      [stage]: outcome.record,
    };
  }
  return {
    [stage]: {
      stopReason: outcome.stopReason,
      toolCalls: outcome.toolCalls,
      durationSeconds: outcome.durationSeconds,
      usage: outcome.usage,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...outcome.record,
    },
  };
}

export interface RuntimeTarget {
  role: RoleName;
  runtimeArn: string;
  runtimeId: string;
  /** The endpoint invoked, `live` in normal running. */
  qualifier: string;
}

/**
 * Read and check the role and its Runtime from the task's environment: the
 * Runtime is named by RUNTIME_ARN and RUNTIME_QUALIFIER, and must be the
 * role's own, `factorial_<role>-…`.
 */
export function runtimeTarget(env: Record<string, string | undefined>): RuntimeTarget {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
  };
  const role = required('ROLE');
  if (!isRoleName(role)) throw new Error(`Unknown agent role "${role}"`);
  const runtimeArn = required('RUNTIME_ARN');
  const match = /^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:[0-9]{12}:runtime\/([A-Za-z0-9_-]+)$/.exec(runtimeArn);
  const runtimeId = match?.[1];
  if (!runtimeId || !new RegExp(`^factorial_${role}-[A-Za-z0-9]+$`).test(runtimeId)) {
    throw new Error(`RUNTIME_ARN does not name the ${role} runtime`);
  }
  const qualifier = required('RUNTIME_QUALIFIER');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(qualifier)) throw new Error(`"${qualifier}" is not an endpoint name`);
  return { role, runtimeArn, runtimeId, qualifier };
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
