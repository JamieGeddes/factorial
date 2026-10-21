import type { WorkItem } from '@factorial/workitem';

import type { WorkContext } from '../lib/context.ts';
import type { PlanDigest } from '../lib/plan-files.ts';

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

/** The heading the builder's prompt asks it to report each plan step under, in summary.md. */
export const PLAN_STEPS_HEADING = '## Plan steps';

/** Take the builder's report on the plan's steps out of its summary, so it can sit with the plan. */
export function splitPlanSteps(summary: string): { rest: string; steps?: string } {
  const lines = summary.split('\n');
  const start = lines.findIndex((line) => line.trim().toLowerCase() === PLAN_STEPS_HEADING.toLowerCase());
  if (start === -1) return { rest: summary };
  const after = lines.slice(start + 1);
  const next = after.findIndex((line) => /^#{1,2} /.test(line));
  const end = next === -1 ? lines.length : start + 1 + next;
  const steps = lines.slice(start + 1, end).join('\n').trim();
  const rest = [...lines.slice(0, start), ...lines.slice(end)].join('\n').trim();
  return { rest, ...(steps ? { steps } : {}) };
}

/** Find the builder's reported line for a plan step id: an optional bullet and optional backticks, then the id, then ':' or whitespace. */
export function stepLineFor(steps: string, id: string): string | undefined {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^(?:[-*] |)?(?:\`${escaped}\`|${escaped})(?=[\\s:]|$)`);
  for (const line of steps.split('\n')) {
    if (pattern.test(line.trim())) return line.trim();
  }
  return undefined;
}

/**
 * The plan the builder followed, with the builder's account of each step
 * under it, matched by plan step id. When no reported line matches a step,
 * the builder's report is shown as it was written, so nothing is lost.
 */
export function planSection(plan: PlanDigest, builderSteps: string | undefined): string {
  const lines = plan.steps.map((step) => (builderSteps ? stepLineFor(builderSteps, step.id) : undefined));
  const reported = builderSteps?.split('\n').map((line) => line.trim()).filter(Boolean) ?? [];
  const unmatched = reported.filter((line) => !lines.includes(line));
  const report = !builderSteps
    ? ['', '_The builder did not report on the plan\'s steps._']
    : lines.every((line) => line === undefined)
      ? ['', '### How the builder followed it', '', builderSteps]
      : unmatched.length
        ? ['', `Steps the builder reported that are not in the plan: ${unmatched.join('; ')}`]
        : [];
  return [
    '## Plan',
    '',
    plan.summary.trim(),
    '',
    ...plan.steps.map((step, i) => {
      const line = lines[i]?.replace(/^(?:[-*] )?/, '- ');
      return [`${i + 1}. \`${step.id}\`: ${step.description}`, ...(line ? [`   ${line}`] : [])].join('\n');
    }),
    ...report,
  ].join('\n');
}

/** The pull request description: the agent's summary, the plan, the closing reference, then the evidence. */
export function pullRequestBody(ctx: WorkContext, summary: string, test: TestResult, headSha: string, plan?: PlanDigest): string {
  const { rest, steps } = plan ? splitPlanSteps(summary) : { rest: summary, steps: undefined };
  const summaryText = (rest.trim() || '_The agent did not write a summary._') + (plan ? `\n\n${planSection(plan, steps)}` : '');
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
