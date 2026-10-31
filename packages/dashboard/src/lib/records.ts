/**
 * The parts of the ledger and thread rows the command centre reads, as
 * `docs/finding-a-run.md` describes them. Every field is optional: rows from
 * before #15, #163 and #165 lack the newer ones.
 */

/*
 * `StageEntry`, `RunEntry` and `PullRequestOutcome` mirror `@factorial/progress`,
 * the module that writes them. They are copied, not imported: that module
 * validates with ajv against the contract schema, which a browser bundle has no
 * use for. Its tests and the contract are the record of the shape.
 */
export interface RunEntry {
  role?: string;
  runtimeName?: string;
  runtimeVersion?: string;
  harness?: { name: string; version?: string };
  modelId?: string;
  effort?: string;
  sessionId?: string;
  toolCalls?: number;
  turns?: number;
  durationSeconds?: number;
  stopReason?: string;
  outcome?: 'complete' | 'incomplete' | 'failed';
  usage?: Record<string, number>;
  costUsd?: number;
  transcriptKey?: string;
  usageKey?: string;
}

export interface StageEntry {
  round?: number;
  startedAt?: string;
  endedAt?: string;
  outcome?: 'succeeded' | 'failed';
  error?: { name: string; message?: string };
  run?: RunEntry;
}

export interface PullRequestOutcome {
  state: 'merged' | 'closed';
  at: string;
  by: string;
  mergeCommit?: string;
}

/** The run's progress the invoker keeps on the row's `live` attribute (#194). */
export interface LiveProgress {
  role?: string;
  stage?: string;
  round?: number;
  at?: string;
  seq?: number;
  events?: number;
  toolCalls?: number;
  modelCalls?: number;
  turns?: number;
  usage?: Record<string, number>;
  costUsd?: number;
  elapsedSeconds?: number;
  lastEvent?: { type?: string; at?: string };
  limits?: { maxTurns?: number; maxBudgetUsd?: number; maxDurationSeconds?: number };
  ended?: boolean;
}

export interface LedgerWorkItem {
  id?: string;
  title?: string;
  body?: string;
  requestedBy?: string;
  createdAt?: string;
  source?: { type?: string; id?: string; url?: string };
  repository?: { provider?: string; owner?: string; name?: string };
  inReplyTo?: { kind?: string; number?: number };
  context?: { pullRequest?: { number?: number } };
}

export interface LedgerRow {
  workItemId: string;
  workItem?: LedgerWorkItem;
  status?: string;
  /** The turn's outcome result (#165), set on every terminal path. */
  result?: string;
  route?: string;
  refusedReason?: string;
  attempt?: number;
  artefactPrefix?: string;
  executionArn?: string;
  factorialVersion?: string;
  threadKey?: string;
  branch?: string;
  baseBranch?: string;
  prNumber?: number;
  prUrl?: string;
  savedWork?: boolean;
  buildRounds?: number;
  createdAt?: string;
  updatedAt?: string;
  endedAt?: string;
  stages?: Record<string, StageEntry>;
  live?: LiveProgress;
  reviewVerdict?: string;
  reviewScores?: Record<string, number>;
  reviewFindings?: Record<string, number>;
  reworkOf?: { previousWorkItemId?: string; prNumber?: number };
  resumedFrom?: string;
  [field: string]: unknown;
}

export interface ThreadRow {
  threadKey: string;
  owner?: string;
  name?: string;
  branch?: string;
  openedBy?: string;
  prNumber?: number;
  prOpenedBy?: string;
  outcome?: PullRequestOutcome;
  inFlight?: { workItemId?: string; since?: string };
  automaticReworks?: number;
  [field: string]: unknown;
}
