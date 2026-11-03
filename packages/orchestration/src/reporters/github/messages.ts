/**
 * What the GitHub reporter says, built only from the facts in `report.json`
 * and the outcome's pointers. The wording is GitHub's: another source's
 * reporter words the same facts its own way.
 */
import { agentBlock } from '../../functions/pr-body.ts';
import type { ProposalFacts, ReportFacts } from '../../lib/report-file.ts';

/** How much of what the agent said a no-changes comment shows. */
export const AGENT_SAID_CHARS = 4000;
/** The most a proposal's comment may take: inside GitHub's 65,536-character comment. */
export const PROPOSAL_COMMENT_CHARS = 60_000;
/** Below this much room, plan.md is left out of the comment rather than shown as a stub. */
const MIN_PLAN_NOTES_CHARS = 500;

/** The work item's commits over every round, when known: a round's own count says nothing about what the branch holds. */
function commitsNote(commits: number | undefined): string {
  return commits === 1 ? ' (1 commit)' : commits ? ` (${commits} commits)` : '';
}

/** A sentence pointing at the pushed branch, when there is one. */
export function savedWorkNote(facts: Pick<ReportFacts, 'rework' | 'savedWork'>, repository: { owner: string; name: string }): string {
  const saved = facts.savedWork;
  if (!saved) return '';
  const commits = commitsNote(saved.commits);
  if (facts.rework) {
    return ` Work in progress${commits} was saved to this pull request's branch, so the pull request now includes it untested. Do not merge until it is finished and its checks pass.`;
  }
  const url = `https://github.com/${repository.owner}/${repository.name}/tree/${saved.branch.split('/').map(encodeURIComponent).join('/')}`;
  return ` Work in progress${commits} was saved to [\`${saved.branch}\`](${url}); it is untested and no pull request was opened. Adding the label again resumes from that branch.`;
}

/** The comment for a turn that opened or updated no pull request. */
export function reportMessage(facts: ReportFacts, repository: { owner: string; name: string }): string {
  const notOpened = facts.rework ? 'the pull request was not updated' : 'no pull request was opened';
  const session = facts.sessionId ?? 'unknown';
  switch (facts.status) {
    case 'no-changes':
      return [
        `Factorial ran but made no changes, so ${notOpened}.`,
        // Agent text: capped, headings and tags neutralised, and no mentions.
        facts.agentSaid?.trim() ? `\n**The agent said:**\n\n${agentBlock(facts.agentSaid.trim(), AGENT_SAID_CHARS)}` : '',
      ].join('\n');
    case 'tests-failed': {
      const run = facts.testRunUrl ? ` ([run](${facts.testRunUrl}))` : '';
      if (facts.rework) {
        return `Factorial's rework did not pass the repository's checks${run}. Its commits are on this pull request's branch, so the pull request now includes them. Do not merge until they are fixed or reverted.`;
      }
      return `Factorial's change did not pass the repository's checks${run}, so no pull request was opened. The branch \`${facts.branch ?? ''}\` is left for inspection.`;
    }
    case 'invalid-plan': {
      const problems = facts.planProblems ?? [];
      return [
        `Factorial's builder did not produce a valid plan, so nothing was pushed. Session \`${session}\`.`,
        ...(problems.length > 0 ? ['', '**Problems with the last plan:**', '', ...problems.map((p) => `- ${p}`)] : []),
      ].join('\n');
    }
    case 'failed':
      if (facts.incomplete) {
        const rounds = typeof facts.buildRound === 'number' && facts.buildRound > 1 ? ` in ${facts.buildRound} sessions` : '';
        return `Factorial's builder reached its iteration or time limit${rounds} before finishing, so the change was not tested and ${notOpened}. Session \`${session}\`.${savedWorkNote(facts, repository)}`;
      }
      // Deliberately generic: causes can contain command output. Details stay
      // in the execution history and the ledger, both inside the account.
      return `Factorial could not complete this work item (\`${facts.errorName ?? 'unknown error'}\`). Session \`${session}\`; see the Factorial execution log.${savedWorkNote(facts, repository)}`;
  }
}

/**
 * The comment that proposes a plan (#169): what to do next, then the steps
 * an approved build follows, whole (plan.json, rendered by Report), then
 * the planner's plan.md, collapsed and capped, as context only. plan.md is
 * agent text: headings and tags neutralised, no mentions.
 */
export function proposalMessage(proposal: ProposalFacts): string {
  const head = [
    `Factorial proposes the plan below and has changed nothing. Session \`${proposal.sessionId}\`.`,
    '',
    `To have it built, add the label that starts work to this issue: the change is built on \`${proposal.branch}\` from exactly these steps, without planning again. For a different plan, edit the issue and add the plan label again.`,
    '',
    '**The plan an approved build follows** (plan.json, shown literally):',
    '',
    proposal.steps,
  ].join('\n');
  const room = PROPOSAL_COMMENT_CHARS - head.length - 200;
  const notes =
    room >= MIN_PLAN_NOTES_CHARS && proposal.plan.trim()
      ? ['', '<details>', "<summary>The planner's notes (plan.md): context only, not given to the build</summary>", '', agentBlock(proposal.plan.trim(), room), '', '</details>']
      : ['', "_The planner's notes (plan.md) are too long to show here. They are context only and not given to the build, which follows the plan above._"];
  return [head, ...notes].join('\n');
}

/** The comment on the issue once its pull request is open. */
export function pullRequestOpenedMessage(url: string): string {
  return `Factorial has opened ${url} for review.`;
}
