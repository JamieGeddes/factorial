/**
 * Thread policies: whether a turn may run on its thread (#163). Intake
 * applies them with the pull request as GitHub reports it and the thread's
 * record, then claims the thread with one conditional write, so of two turns
 * that arrive together exactly one runs.
 *
 * - The pull request must be open, opened by Factorial, from this repository
 *   and still headed by the thread's branch.
 * - One turn in flight per thread: a second would race the first, and the
 *   clean-room push would refuse it once the head moved.
 * - At most two automatic reworks after failed checks without a person
 *   asking in between, so a change that cannot pass does not loop.
 *
 * Nothing releases a claim. The thread names the turn holding it, and that
 * turn's ledger status says whether it has finished, so a turn that dies
 * without reporting holds its thread only until it goes stale.
 */
import type { PullRequestState } from '@factorial/github-app';
import type { WorkItemReworkCause } from '@factorial/workitem';

/** Statuses after which an item no longer holds its thread. Anything else is in flight. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'pr-opened',
  'pr-updated',
  'no-changes',
  'tests-failed',
  'failed',
  'invalid-plan',
  'not-eligible',
  'busy',
  'rework-limit',
  'covered-by-review',
]);

/**
 * A turn still not finished after this long is taken to have died without
 * reporting, so it no longer holds its thread. Longer than the most a build
 * can take (`MaxBuildRounds` sessions of 6,600 seconds) plus tests and review.
 */
export const STALE_AFTER_MS = 8 * 60 * 60 * 1000;

export const MAX_AUTOMATIC_REWORKS = 2;

/** Why Factorial may not work on this pull request on this branch, or undefined when it may. */
export function pullRequestMismatch(pr: PullRequestState, branch: string, botLogin: string): string | undefined {
  if (pr.state !== 'open') return `pull request #${pr.number} is ${pr.state}`;
  if (pr.authorLogin.toLowerCase() !== botLogin.toLowerCase()) return `pull request #${pr.number} was not opened by Factorial`;
  if (pr.headRepoId !== pr.baseRepoId) return `pull request #${pr.number} comes from another repository`;
  if (pr.headRef !== branch) return `pull request #${pr.number} is on ${pr.headRef}, not ${branch}`;
  return undefined;
}

/** The part of a thread's record that admission reads and a claim writes. */
export interface ThreadState {
  /** The turn holding the thread, and when it claimed it. */
  inFlight?: { workItemId: string; since: string };
  /** Automatic reworks after failed checks since a person last asked. */
  automaticReworks?: number;
  /** Whether the limit on automatic reworks has been announced on the pull request. */
  limitAnnounced?: boolean;
}

/** A turn asking to run: its cause when it continues a pull request, none for a new or resumed request. */
export interface TurnRequest {
  workItemId: string;
  cause?: WorkItemReworkCause;
}

export type Admission =
  | { ok: true; claim: Required<ThreadState> }
  | {
      ok: false;
      status: 'busy' | 'rework-limit';
      reason: string;
      /** A reply for the pull request, when a person asked or the limit is new. */
      reply?: string;
      /** Set when this refusal announces the limit, so the thread records that it has. */
      announces?: true;
    };

/** Whether a person asked for the turn, so a refusal is answered and the automatic count starts again. */
const personAsked = (cause: WorkItemReworkCause | undefined): boolean => cause === 'review' || cause === 'comment';

/**
 * Admit or refuse a turn, given its thread and the ledger status of the turn
 * holding it. A refusal after a person asked carries a reply; an automatic
 * one is only recorded, since failed checks can arrive while Factorial's own
 * rework is still running. An admission carries the thread's new state.
 */
export function admitTurn(turn: TurnRequest, thread: ThreadState, holderStatus: string | undefined, now: Date): Admission {
  const holder = thread.inFlight;
  if (
    holder &&
    holder.workItemId !== turn.workItemId &&
    !TERMINAL_STATUSES.has(holderStatus ?? '') &&
    now.getTime() - Date.parse(holder.since) < STALE_AFTER_MS
  ) {
    return {
      ok: false,
      status: 'busy',
      reason: `work item ${holder.workItemId} is still running on this pull request`,
      ...(personAsked(turn.cause)
        ? { reply: `Factorial is already working on this pull request (work item \`${holder.workItemId}\`), so this request was not started. Ask again once it has replied.` }
        : {}),
    };
  }

  const automatic = thread.automaticReworks ?? 0;
  const checks = turn.cause === 'checks-failed';
  if (checks && automatic >= MAX_AUTOMATIC_REWORKS) {
    return {
      ok: false,
      status: 'rework-limit',
      reason: `${automatic} automatic reworks after failed checks without a human asking in between`,
      // Say it once: later failures refused for the same reason stay quiet.
      ...(thread.limitAnnounced
        ? {}
        : {
            reply: `Factorial has already tried to fix the failing checks on this pull request ${MAX_AUTOMATIC_REWORKS} times without anyone asking in between, so it has not started again. Address it in a comment to have it try once more.`,
            announces: true as const,
          }),
    };
  }

  return {
    ok: true,
    claim: {
      inFlight: { workItemId: turn.workItemId, since: holder?.workItemId === turn.workItemId ? holder.since : now.toISOString() },
      automaticReworks: checks ? automatic + 1 : 0,
      limitAnnounced: checks ? thread.limitAnnounced === true : false,
    },
  };
}
