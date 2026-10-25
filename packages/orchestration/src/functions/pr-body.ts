import type { WorkItem } from '@factorial/workitem';

import type { Plan } from '@factorial/plan';

import {
  SUMMARY_CAPS,
  cutText,
  parseBuilderSummary,
  replaceEmDashes,
  type BuilderSummary,
  type StepReport,
} from '../lib/builder-summary.ts';
import type { WorkContext } from '../lib/context.ts';
import type { PlanDigest } from '../lib/plan-files.ts';
import type { PrFacts } from '../lib/pr-facts.ts';
import { GUARD_FINDING_PREFIX, type ReviewDigest } from '../lib/review-files.ts';

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

/**
 * The pull request description. Every PR has the same sections in the same
 * order: Summary, Impact, Review focus, Automated review, Tests, Plan and
 * (collapsed) Run details. Facts the orchestrator computed (paths,
 * dependencies, deploy settings, the test result, the plan, the review) never
 * come from agent text; the builder's own words fill only the slots set aside
 * for them, are capped, and go through `agentText`. Each section is a pure
 * function of its inputs.
 */

const NOT_REPORTED = '_Not reported by the builder._';
const MAX_FOCUS_ITEMS = 5;
const FOCUS_ITEM_CHARS = 220;
const MAX_LIST = 5;

/**
 * Text written by an agent, made safe for its slot: no headings, no dashes
 * the body bans, no tags that could close the body's own collapsed blocks,
 * on one line, and cut to `max`.
 */
export function agentText(text: string, max: number): string {
  const flat = replaceEmDashes(text)
    .replace(/<(?=\/?(?:details|summary)\b)/gi, '&lt;')
    .split('\n')
    .map((line) => line.replace(/^\s*#{1,6}\s+/, '').trim())
    .filter(Boolean)
    .join(' ');
  return cutText(flat, max);
}

/** Free text from an agent that may run to several paragraphs: kept as lines, headings and tags neutralised, then cut. */
function agentBlock(text: string, max: number): string {
  const lines = replaceEmDashes(text)
    .replace(/<(?=\/?(?:details|summary)\b)/gi, '&lt;')
    .split('\n')
    .map((line) => line.replace(/^\s*#{1,6}\s+/, '').trimEnd());
  return cutText(lines.join('\n'), max);
}

/** The plan as the PR needs it: from the full plan when it could be read back, otherwise from the state's digest. */
interface PlanView {
  summary: string;
  steps: Array<{ id: string; description: string }>;
  followUp: string[];
  openQuestions: string[];
  plannedTests: string[];
}

export interface BodyExtras {
  /** The plan as the state carries it; shortened descriptions. */
  plan?: PlanDigest | null | undefined;
  /** The plan read back from the artefact store, with untruncated descriptions. */
  fullPlan?: Plan | null | undefined;
  review?: ReviewOutcome;
  /** What the orchestrator computed; null or absent when the review stage did not run. */
  facts?: PrFacts | null | undefined;
}

function planView(extras: BodyExtras): PlanView | undefined {
  const { fullPlan, plan } = extras;
  if (fullPlan) {
    return {
      summary: fullPlan.summary,
      steps: fullPlan.steps.map((s) => ({ id: s.id, description: s.description })),
      followUp: fullPlan.followUp ?? [],
      openQuestions: fullPlan.openQuestions,
      plannedTests: fullPlan.tests.add,
    };
  }
  if (plan) return { summary: plan.summary, steps: plan.steps, followUp: plan.followUp ?? [], openQuestions: [], plannedTests: [] };
  return undefined;
}

/** What the builder reported for a plan step: its first line that names the id. */
function reportFor(summary: BuilderSummary | undefined, id: string): StepReport | undefined {
  return summary?.steps.find((s) => s.id === id && s.status !== undefined);
}

/** Summary: what changed and why, in the builder's words, then the closing reference. */
export function summarySection(summary: BuilderSummary | undefined, rawText: string, closes: string | undefined): string {
  const text = summary
    ? summary.summary !== undefined
      ? agentBlock(summary.summary, SUMMARY_CAPS.summary)
      : '_The builder did not write a summary._'
    : rawText.trim()
      ? agentBlock(rawText, SUMMARY_CAPS.summary)
      : '_The builder did not write a summary._';
  return ['## Summary', '', text, ...(closes ? ['', closes] : [])].join('\n');
}

function dependencyLine(facts: PrFacts): string {
  if (facts.dependencies.length === 0) return 'None';
  return facts.dependencies
    .map((d) =>
      d.change === 'added'
        ? `added \`${d.name}\` ${d.version}${d.dev ? ' (dev)' : ''} in \`${d.file}\`, licence: ${d.licence ?? 'unknown'}`
        : `removed \`${d.name}\`${d.dev ? ' (dev)' : ''} from \`${d.file}\``,
    )
    .join('; ');
}

function deployLine(facts: PrFacts): string {
  const { deploy } = facts;
  if (!deploy.configured) return 'Not determined (no `.factorial/pr-body.json` on the base branch); see Behaviour for anything the builder knows of.';
  if (deploy.notes.length === 0 && deploy.humanSteps.length === 0) return 'None';
  const human = deploy.humanSteps.length ? `**Human step needed:** ${deploy.humanSteps.join('; ')}` : 'No human step needed.';
  return `${deploy.notes.length ? `${deploy.notes.join('; ')}. ` : ''}${human}`;
}

/** Impact: five bullets, always all present, "None" when one does not apply. */
export function impactSection(summary: BuilderSummary | undefined, facts: PrFacts | null | undefined): string {
  const unknown = 'Not determined (the review stage did not run).';
  const behaviour = summary?.behaviour !== undefined ? agentText(summary.behaviour, SUMMARY_CAPS.behaviour) : NOT_REPORTED;
  const breaking = summary
    ? summary.breaking !== undefined
      ? agentText(summary.breaking, SUMMARY_CAPS.breaking)
      : 'None'
    : NOT_REPORTED;
  return [
    '## Impact',
    '',
    `- **Behaviour:** ${behaviour}`,
    `- **Deploy:** ${facts ? deployLine(facts) : unknown}`,
    `- **Contracts:** ${facts ? (facts.contracts.length ? facts.contracts.map((c) => `\`${c}\``).join(', ') : 'None') : unknown}`,
    `- **Dependencies:** ${facts ? dependencyLine(facts) : unknown}`,
    `- **Breaking changes or migration:** ${breaking}`,
  ].join('\n');
}

const focusText = (text: string): string => agentText(text, FOCUS_ITEM_CHARS);

/**
 * Review focus: at most five items, most important first. Sensitive paths and
 * contract changes (computed), then the reviewer's high then medium findings,
 * then the builder's uncertainties, then the plan's open questions.
 */
export function reviewFocusSection(summary: BuilderSummary | undefined, facts: PrFacts | null | undefined, review: ReviewOutcome, plan: PlanView | undefined): string {
  const items: string[] = [];
  const sensitive = new Set<string>();
  for (const change of facts?.sensitive ?? []) {
    sensitive.add(change.path);
    items.push(`\`${change.path}\`: ${focusText(change.reason)}.`);
  }
  for (const path of facts?.contracts ?? []) {
    if (!sensitive.has(path)) items.push(`\`${path}\`: changes a contract other components depend on.`);
  }
  if (review?.ok) {
    for (const severity of ['high', 'medium'] as const) {
      for (const f of review.review.findings) {
        if (f.severity !== severity || f.body.startsWith(GUARD_FINDING_PREFIX)) continue;
        items.push(`\`${f.line ? `${f.path}:${f.line}` : f.path}\`: ${focusText(f.body)}`);
      }
    }
  }
  for (const u of summary?.uncertainties ?? []) items.push(`Builder was unsure: ${focusText(u)}`);
  for (const q of plan?.openQuestions ?? []) items.push(`Open question in the plan: ${focusText(q)}`);
  const shown = items.slice(0, MAX_FOCUS_ITEMS);
  return [
    '## Review focus',
    '',
    ...(shown.length ? shown.map((item, i) => `${i + 1}. ${item}`) : ['Nothing needs particular attention.']),
  ].join('\n');
}

/** What the Review stage handed on: a review, the reason there is none, or nothing for runs before the stage existed. */
export type ReviewOutcome = { ok: true; review: ReviewDigest } | { ok: false; errors?: string[] } | null | undefined;

const VERDICTS: Record<ReviewDigest['verdict'], string> = {
  approve: 'Approve',
  'request-changes': 'Request changes',
  comment: 'Comment',
};

function findingLine(finding: ReviewDigest['findings'][number], withSeverity: boolean): string {
  const where = finding.line ? `${finding.path}:${finding.line}` : finding.path;
  return `- ${withSeverity ? `**${finding.severity}** ` : ''}\`${where}\`: ${agentText(finding.body, 600)}`;
}

/**
 * The automated review, advisory: verdict and scores on one line, then the
 * reviewer's high-severity findings, the rest collapsed. The orchestrator's
 * own guard findings are left out; Review focus lists those paths. With no
 * valid review, a fixed sentence: validation errors can quote text from the
 * reviewer's session, so they stay in the artefact store.
 */
export function reviewSection(outcome: ReviewOutcome): string {
  if (outcome === undefined) return ['## Automated review', '', '_No automated review ran for this pull request._'].join('\n');
  if (!outcome || !outcome.ok) {
    return [
      '## Automated review',
      '',
      '_The automated review did not complete. It is advisory, so the pull request was opened anyway; the details are under `review/` in the artefacts._',
    ].join('\n');
  }
  const { review } = outcome;
  const { correctness, completeness, tests, safety } = review.scores;
  const own = review.findings.filter((f) => !f.body.startsWith(GUARD_FINDING_PREFIX));
  const high = own.filter((f) => f.severity === 'high');
  const other = own.filter((f) => f.severity !== 'high');
  const omitted = review.totalFindings - review.findings.length;
  return [
    '## Automated review',
    '',
    `**${VERDICTS[review.verdict]}** · correctness ${correctness}/5 · completeness ${completeness}/5 · tests ${tests}/5 · safety ${safety}/5 (advisory, does not block)`,
    ...(high.length ? ['', '**High severity**', '', ...high.map((f) => findingLine(f, false))] : []),
    ...(other.length
      ? ['', '<details>', `<summary>${other.length} other finding${other.length === 1 ? '' : 's'}</summary>`, '', ...other.map((f) => findingLine(f, true)), '', '</details>']
      : []),
    ...(omitted > 0 ? ['', `_${omitted} more finding${omitted === 1 ? '' : 's'} in \`review/review.json\` in the artefacts._`] : []),
  ].join('\n');
}

export interface TestResult {
  runUrl?: string;
  outcome?: string;
}

const listPaths = (paths: readonly string[]): string => {
  const shown = paths.slice(0, MAX_LIST).map((p) => `\`${p}\``).join(', ');
  return paths.length > MAX_LIST ? `${shown} and ${paths.length - MAX_LIST} more` : shown;
};

/**
 * Tests: the CI result with its run, the test files the change touches (from
 * the diff), and what the builder says is not tested. The plan's `tests.add`
 * is what was planned, so it is labelled as that and collapsed.
 */
export function testsSection(test: TestResult, summary: BuilderSummary | undefined, facts: PrFacts | null | undefined, plan: PlanView | undefined): string {
  const result = test.runUrl ? `[${test.outcome ?? 'run'}](${test.runUrl})` : 'not run';
  const files = facts ? (facts.testFiles.length ? listPaths(facts.testFiles) : 'none among the changed files') : 'not determined (the review stage did not run)';
  const notTested = summary?.notTested === undefined
    ? NOT_REPORTED
    : summary.notTested.length
      ? summary.notTested.slice(0, SUMMARY_CAPS.notTestedBullets).map((n) => agentText(n, SUMMARY_CAPS.uncertainty)).join('; ')
      : 'Nothing reported.';
  return [
    '## Tests',
    '',
    `- **Result:** ${result}`,
    `- **Test files added or changed:** ${files}`,
    `- **Not tested:** ${notTested}`,
    ...(plan?.plannedTests.length
      ? ['', '<details>', '<summary>Planned tests (from the plan, not a report of what was added)</summary>', '', ...plan.plannedTests.map((t) => `- ${agentText(t, 300)}`), '', '</details>']
      : []),
  ].join('\n');
}

function outcomeFor(report: StepReport | undefined): string {
  if (!report?.status) return 'not reported';
  return report.note ? `${report.status}: ${agentText(report.note, SUMMARY_CAPS.stepNote)}` : report.status;
}

/**
 * Plan: departures only, from the builder's step report (a status read from
 * the fixed position in its line, not from its wording). The full list sits
 * in a collapsed block, once.
 */
export function planSection(plan: PlanView | undefined, summary: BuilderSummary | undefined): string {
  if (!plan) return ['## Plan', '', '_There was no plan for this run._'].join('\n');
  const reports = plan.steps.map((s) => reportFor(summary, s.id));
  const departures = plan.steps.flatMap((s, i) => {
    const report = reports[i];
    if (report?.status === 'done') return [];
    return [`- \`${s.id}\`: ${outcomeFor(report)}`];
  });
  const none = reports.every((r) => r === undefined);
  const headline = none
    ? `_The builder did not report on the plan's ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}._`
    : departures.length === 0
      ? `Every step was done as planned (${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}).`
      : `${departures.length} of ${plan.steps.length} steps departed from the plan or were not reported:`;
  return [
    '## Plan',
    '',
    headline,
    ...(!none && departures.length ? ['', ...departures] : []),
    '',
    '<details>',
    '<summary>All plan steps</summary>',
    '',
    ...plan.steps.map((s, i) => `${i + 1}. \`${s.id}\` (${outcomeFor(reports[i])}): ${agentText(s.description, 2000)}`),
    ...(plan.followUp.length
      ? ['', "For a separate work item, in the planner's judgement:", '', ...plan.followUp.map((item) => `- ${agentText(item, 300)}`)]
      : []),
    '',
    '</details>',
  ].join('\n');
}

/** Run details: the metadata table, collapsed. Only values the orchestrator knows; the artefact prefix without the bucket, which carries the account ID. */
export function runDetailsSection(ctx: WorkContext, headSha: string): string {
  const rows: Array<[string, string]> = [
    ['Work item', `[${ctx.workItem.source.type} ${ctx.workItem.source.id}](${ctx.workItem.source.url})`],
    ['Requested by', `@${ctx.workItem.requestedBy}`],
    ['Head', `\`${headSha.slice(0, 12)}\``],
    ['Built by', `Factorial \`${ctx.factorialVersion.slice(0, 12)}\``],
    ['Session', `\`${ctx.sessionId}\``],
    ['Artefacts', `\`${ctx.artefactPrefix}\``],
  ];
  return [
    '<details>',
    '<summary>Run details</summary>',
    '',
    '| | |',
    '|---|---|',
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    '',
    '</details>',
  ].join('\n');
}

/** The pull request description. The builder's text is `summaryText`, as read from summary.md. */
export function pullRequestBody(ctx: WorkContext, summaryText: string, test: TestResult, headSha: string, extras: BodyExtras = {}): string {
  const summary = parseBuilderSummary(summaryText);
  const plan = planView(extras);
  const facts = extras.facts ?? null;
  const body = [
    summarySection(summary, summaryText, closingReference(ctx.workItem)),
    impactSection(summary, facts),
    reviewFocusSection(summary, facts, extras.review, plan),
    reviewSection(extras.review),
    testsSection(test, summary, facts, plan),
    planSection(plan, summary),
    runDetailsSection(ctx, headSha),
  ].join('\n\n');
  // Whatever the sections let through, the body has no em or en dashes.
  return `${replaceEmDashes(body)}\n`;
}
