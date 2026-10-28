import type { WorkItem } from '@factorial/workitem';

/** A changed file the orchestrator flagged for care, and why. */
export interface SensitivePath {
  path: string;
  reason: string;
}

/** What a role's first message needs beyond the work item: the builder's round, the reviewer's sensitive paths. */
export interface FirstMessageOptions {
  sensitivePaths?: readonly SensitivePath[];
  /** The round: 2 or more when continuing in a fresh session. */
  round?: number;
  /** Whether this attempt resumes an earlier one's branch. */
  resumed?: boolean;
}

/** A model a role uses beyond its main loop, read from `FACTORIAL_<PURPOSE>_MODEL` on the Runtime version. */
export type ModelPurpose = 'explore';

/**
 * What one agent role is, as the host, the invoker and the orchestrator all
 * need to agree on it. The host's own parts of the role (system prompt,
 * tools, subagents, hooks) are in packages/agent-runtime/src/roles/: only the
 * host's copy is fixed on the Runtime version, so only the host holds them.
 */
export interface RoleManifest {
  /** `factorial_<name>` is its Runtime, `factorial-agent-<name>` its execution role. */
  name: string;
  /** The artefact folder under the attempt's prefix, and the log stage. */
  stage: string;
  /** The ledger statuses for a run of the role. */
  statuses: { running: string; done: string; failed: string };
  /** Models beyond the main loop, each required on the role's Runtime version. */
  models: readonly ModelPurpose[];
  /**
   * Whether a run that ends without an error but short of success is
   * incomplete. A half-finished build must not become a pull request; a
   * reviewer's output is judged by what it left behind.
   */
  mustFinish: boolean;
  /**
   * Whether the role continues in fresh sessions. A later round's records go
   * under `<stage>/round-<n>/`, and the ledger keeps `<stage>Rounds` and
   * `<stage>UsageTotal` across rounds.
   */
  rounds: boolean;
  /**
   * Where the ledger keeps a run's outcome: at the top level (the builder's
   * names from before other roles, `stopReason`, `usage`,
   * `<stage>DurationSeconds`, ...) or under `<stage>`.
   */
  ledger: 'top-level' | 'stage';
  /** The `# Plan` section of the session's starting notes.md. */
  notesPlan: string;
  /** The user message that starts a session. The system prompt is the Runtime version's. */
  firstMessage(workItem: WorkItem, branch: string, baseBranch: string, options: FirstMessageOptions): string;
}
