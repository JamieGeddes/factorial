/**
 * The notifier for work items that came from a labelled GitHub issue: when
 * Build starts in round 1, react to the issue with eyes and say once that
 * work has started. Everything else is spoken for already: Intake reacts to
 * comment turns, Report and OpenPullRequest answer at the end.
 */
import type { ProgressEvent } from '@factorial/progress';

import type { Notifier } from './types.ts';

const ISSUE_URL = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/issues\/([1-9][0-9]*)$/;

/**
 * The issue number in an issue's URL, `https://github.com/<owner>/<name>/issues/<number>`,
 * if the URL is that shape and names the event's repository (case aside).
 */
export function issueNumberFromUrl(url: string, repository: ProgressEvent['repository']): number | undefined {
  const match = ISSUE_URL.exec(url);
  if (!match) return undefined;
  const [, owner = '', name = '', digits = ''] = match;
  if (owner.toLowerCase() !== repository.owner.toLowerCase() || name.toLowerCase() !== repository.name.toLowerCase()) return undefined;
  const number = Number(digits);
  return Number.isSafeInteger(number) ? number : undefined;
}

/** The comment: no event content, no user text. */
export function startedComment(workItemId: string): string {
  return `Factorial has started work on this issue (work item \`${workItemId}\`). A pull request or a comment here will follow.`;
}

export const githubIssueNotifier: Notifier = async (event, deps) => {
  // Round 1 of the build is the only start without a `round`: it is recorded from round 2.
  if (event.stage !== 'Build' || event.transition !== 'started' || event.round !== undefined) return;

  const number = issueNumberFromUrl(event.source.url, event.repository);
  if (number === undefined) {
    deps.log.error('issue number not readable', { url: event.source.url });
    return;
  }

  const at = deps.now();
  if (!(await deps.ledger.claimStarted(event.workItemId, at))) {
    deps.log.info('started notice already sent, or no ledger row', {});
    return;
  }

  const repo = { owner: event.repository.owner, name: event.repository.name };
  try {
    const client = await deps.github(repo, { issues: 'write' });
    try {
      await client.addIssueReaction(repo, number, 'eyes');
    } catch (error) {
      // The comment is what matters; a missing reaction is not worth a retry.
      deps.log.error('reaction failed', { error });
    }
    await client.commentOnIssue(repo, number, startedComment(event.workItemId));
  } catch (error) {
    // Let the retry send the notice, instead of leaving the issue without one.
    try {
      await deps.ledger.releaseStarted(event.workItemId, at);
    } catch (releaseError) {
      deps.log.error('claim not released', { error: releaseError });
    }
    throw error;
  }
  deps.log.info('started notice sent', { issue: number });
};
