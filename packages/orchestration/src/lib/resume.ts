/**
 * Resuming a failed attempt. When a work item from the same source (the same
 * issue, say) stopped early but left its work on a branch, the next attempt
 * continues on that branch instead of starting again from the default branch.
 */
import type { WorkItem } from '@factorial/workitem';

/** One earlier attempt at the same source, as the ledger's source index returns it. */
export interface Attempt {
  workItemId: string;
  status?: string;
  branch?: string;
  savedWork?: boolean;
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
