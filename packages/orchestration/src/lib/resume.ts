/**
 * Resuming a failed attempt. When a work item from the same source (the same
 * issue, say) stopped early but left its work on a branch, the next attempt
 * continues on that branch instead of starting again from the default branch.
 */
import type { WorkItem } from '@factorial/workitem';

/** One earlier attempt at the same source: a turn on the newest thread the source opened. */
export interface Attempt {
  workItemId: string;
  status?: string;
  branch?: string;
  savedWork?: boolean;
  /** Read from the attempt's own row. */
  attempt?: number;
}

/** The ledger key that groups attempts at the same source in the same repository. */
export function sourceKey(workItem: WorkItem): string {
  const { owner, name } = workItem.repository;
  return `${workItem.source.type}#${owner}/${name}#${workItem.source.id}`;
}

/**
 * The attempt to resume, given earlier attempts newest first. A failure that
 * saved work, or a run whose tests failed, can be resumed. A failure that
 * saved nothing is passed over, so a chain of failed resumes still finds the
 * branch. Anything else (a pull request opened, no changes, a run still in
 * progress) ends the search: the new item starts fresh.
 */
export function resumableAttempt(attempts: readonly Attempt[], currentId: string): Attempt | undefined {
  for (const attempt of attempts) {
    if (attempt.workItemId === currentId) continue;
    if (attempt.status === 'failed' && attempt.savedWork !== true) continue;
    const resumable = attempt.status === 'tests-failed' || (attempt.status === 'failed' && attempt.savedWork === true);
    return resumable && attempt.branch ? attempt : undefined;
  }
  return undefined;
}

/**
 * The attempt number for a new item: one more than the attempt it resumes,
 * or 1 when it starts afresh. Rows written before attempts were numbered
 * count as attempt 1.
 */
export function nextAttempt(resumedFrom?: Pick<Attempt, 'attempt'>): number {
  return resumedFrom ? (resumedFrom.attempt ?? 1) + 1 : 1;
}
