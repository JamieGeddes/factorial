import type { WorkItem } from '@factorial/workitem';

import type { WorkContext } from '../lib/context.ts';

export interface TestResult {
  runUrl?: string;
  outcome?: string;
}

const GITHUB_ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)\/issues\/([1-9][0-9]*)\/?$/;

/**
 * A GitHub closing reference for the work item's issue, so merging the PR into
 * the default branch closes it. Short form when the issue lives in the
 * repository being changed, `owner/repo#n` otherwise. Undefined for any
 * other trigger type; those close their own tickets elsewhere.
 */
export function closingReference(workItem: WorkItem): string | undefined {
  if (workItem.source.type !== 'github-issue') return undefined;
  const match = GITHUB_ISSUE_URL.exec(workItem.source.url);
  if (!match) return undefined;
  const [, owner, repo, number] = match;
  const { owner: targetOwner, name: targetName } = workItem.repository;
  const sameRepo = owner?.toLowerCase() === targetOwner.toLowerCase() && repo?.toLowerCase() === targetName.toLowerCase();
  return sameRepo ? `Closes #${number}` : `Closes ${owner}/${repo}#${number}`;
}

/** The pull request description: the agent's summary, the closing reference, then the evidence. */
export function pullRequestBody(ctx: WorkContext, summary: string, test: TestResult, headSha: string): string {
  const summaryText = summary.trim() || '_The agent did not write a summary._';
  const rows: Array<[string, string]> = [
    ['Work item', `[${ctx.workItem.source.type} ${ctx.workItem.source.id}](${ctx.workItem.source.url})`],
    ['Requested by', `@${ctx.workItem.requestedBy}`],
    ['Tests', test.runUrl ? `[${test.outcome ?? 'run'}](${test.runUrl})` : 'not run'],
    ['Head', `\`${headSha.slice(0, 12)}\``],
    ['Built by', `Factorial \`${ctx.factorialVersion.slice(0, 12)}\``],
    ['Session', `\`${ctx.sessionId}\``],
    // The prefix only: the bucket name carries the account ID, which stays out of GitHub.
    ['Artefacts', `\`${ctx.artefactPrefix}\``],
  ];
  const table = ['| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
  const closes = closingReference(ctx.workItem);
  return `${summaryText}\n\n${closes ? `${closes}\n\n` : ''}---\n\n${table}\n`;
}
