/**
 * The Verify stage (#167): what a target declares, and how its verifiers
 * went, as the state machine carries them.
 *
 * Collect reads `.factorial/verifiers.json` from the target's base branch,
 * never from the branch under test, so the builder cannot change the gate.
 * No file means the target declares no verifiers: the change goes on
 * unverified and its pull request says so (decided 2026-10-31). A file that is
 * there but invalid ends the turn, so a typo cannot silently remove a gate.
 */
import { MAX_VERIFIERS_FILE_BYTES, VERIFIERS_FILE, parseVerifierSettings, type Verifier, type VerifierOutcome, type VerifierResult } from '@factorial/verifiers';

/** What Collect hands the state machine: exactly one of the three. */
export type VerifyPlan = { verifiers: Verifier[] } | { skipped: string } | { invalid: string[] };

/** Reads a file's text on a ref, undefined when it is not there (`GitHubClient.fileText`). */
export type ReadFile = (repo: { owner: string; name: string }, path: string, ref: string, maxBytes: number) => Promise<string | undefined>;

/** At most this many problems are carried and shown. */
const MAX_PROBLEMS = 10;

export async function verifyPlan(repo: { owner: string; name: string }, baseBranch: string, read: ReadFile): Promise<VerifyPlan> {
  const text = await read(repo, VERIFIERS_FILE, baseBranch, MAX_VERIFIERS_FILE_BYTES);
  if (text === undefined) return { skipped: `${repo.owner}/${repo.name} declares no verifiers (no ${VERIFIERS_FILE} on ${baseBranch})` };
  const parsed = parseVerifierSettings(text);
  if (!parsed.ok) return { invalid: parsed.errors.slice(0, MAX_PROBLEMS).map((e) => e.slice(0, 300)) };
  return { verifiers: parsed.value.verifiers };
}

/** One verifier's result as the state machine carries it to the pull request: no log, no command. */
export interface VerifierDigest {
  name: string;
  required: boolean;
  outcome: VerifierOutcome;
  sha: string;
  durationSeconds: number;
  detail?: string;
}

/** `$verify` in the state machine: why nothing ran, or each verifier's result in order. */
export type VerifySummary = { skipped: string } | { verifiers: VerifierDigest[] };

export function verifierDigest(result: VerifierResult): VerifierDigest {
  return {
    name: result.name,
    required: result.required,
    outcome: result.outcome,
    sha: result.sha,
    durationSeconds: result.durationSeconds,
    ...(result.detail ? { detail: result.detail } : {}),
  };
}

/** A required verifier that did not pass: the turn ends as `tests-failed`, naming it. */
export class VerifierFailedError extends Error {
  readonly digest: VerifierDigest;

  constructor(digest: VerifierDigest) {
    // The message is the digest, so Report can read it back from the error's cause.
    super(JSON.stringify(digest));
    this.name = 'VerifierFailed';
    this.digest = digest;
  }
}

/** The failed verifier from a VerifierFailed error's cause (a Lambda error object as JSON), if it holds one. */
export function failedVerifierOf(cause: string | undefined): Pick<VerifierDigest, 'name' | 'outcome'> | undefined {
  try {
    const message: unknown = (JSON.parse(cause ?? '') as { errorMessage?: unknown }).errorMessage;
    const digest = JSON.parse(typeof message === 'string' ? message : '') as Partial<VerifierDigest>;
    const name = typeof digest.name === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(digest.name) ? digest.name : undefined;
    const outcome = (['failed', 'timed-out', 'error'] as const).find((o) => o === digest.outcome);
    return name && outcome ? { name, outcome } : undefined;
  } catch {
    return undefined;
  }
}

/** The problems from a VerifyUnconfigured failure's cause (`{"problems": [...]}`, from the state machine). */
export function verifyProblemsOf(cause: string | undefined): string[] {
  try {
    const problems: unknown = (JSON.parse(cause ?? '') as { problems?: unknown }).problems;
    return Array.isArray(problems) ? problems.filter((p): p is string => typeof p === 'string').slice(0, MAX_PROBLEMS) : [];
  } catch {
    return [];
  }
}

/**
 * Why the head may not be presented as verified, or undefined when it may:
 * every verifier the base branch declares as required passed on exactly this
 * commit. Nothing ran when the target declares none, which the pull request
 * says.
 */
export function unverifiedHead(declared: VerifyPlan, verify: VerifySummary, headSha: string): string | undefined {
  if ('invalid' in declared) return 'the verifier settings are invalid';
  if ('skipped' in declared) return 'skipped' in verify ? undefined : 'verifiers ran for a target that declares none';
  if ('skipped' in verify) return 'the target declares verifiers, but none ran';
  for (const verifier of verify.verifiers) {
    if (verifier.sha !== headSha) return `verifier ${verifier.name} ran on ${verifier.sha}, but the branch head is ${headSha}`;
  }
  for (const wanted of declared.verifiers.filter((v) => v.required)) {
    const ran = verify.verifiers.find((v) => v.name === wanted.name);
    if (!ran) return `required verifier ${wanted.name} did not run`;
    if (ran.outcome !== 'passed') return `required verifier ${wanted.name} ${ran.outcome}`;
  }
  return undefined;
}
