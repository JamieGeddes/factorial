/** The verifier contracts' types (contracts/verifiers/v1/), without their validation. */
export const VERIFIER_OUTCOMES = ['passed', 'failed', 'timed-out', 'error'] as const;
export type VerifierOutcome = (typeof VERIFIER_OUTCOMES)[number];

export interface Verifier {
  name: string;
  kind: 'command';
  /** The shell command, run by bash in the repository's root. */
  run: string;
  required: boolean;
  timeoutSeconds: number;
}

/** A target repository's `.factorial/verifiers.json`. */
export interface VerifierSettings {
  schemaVersion: 1;
  verifiers: Verifier[];
}

/** `verify/<name>/result.json`. */
export interface VerifierResult {
  schemaVersion: 1;
  name: string;
  kind: Verifier['kind'];
  required: boolean;
  sha: string;
  outcome: VerifierOutcome;
  exitCode?: number;
  detail?: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  log?: { key: string; bytes: number; truncated: boolean };
}
