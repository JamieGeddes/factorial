import type { WorkItem } from '@factorial/workitem';

import type { Plan } from '@factorial/plan';

import {
  SUMMARY_CAPS,
  codeSpan,
  cutText,
  parseBuilderSummary,
  replaceEmDashes,
  type BuilderSummary,
  type StepReport,
} from '../lib/builder-summary.ts';
import type { ReworkTurn, WorkContext } from '../lib/context.ts';
import type { PlanDigest } from '../lib/plan-files.ts';
import type { PrFacts } from '../lib/pr-facts.ts';
import type { ReworkReplyFacts, RunDetails } from '../lib/report-file.ts';
import { GUARD_FINDING_PREFIX, type ReviewDigest } from '../lib/review-files.ts';
import type { ReworkPoint } from '../lib/rework-points.ts';

export interface TestResult {
  runUrl?: string;
  outcome?: string;
  /** Why Test was skipped (Collect's `testSkipReason`): the change was not verified. */
  skipped?: string;
}

/** The skip reason as the body shows it: one line of text, never markup. */
const skipText = (reason: string): string => reason.replace(/[\r\n`<>]/g, ' ').slice(0, 300);

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
/**
 * Agent text cannot mention anyone: a zero-width space after each `@` that
 * would start a mention or team reference stops GitHub notifying, so a
 * prompt-injected builder cannot ping people from Factorial's comments.
 * Applied everywhere, code spans included, and after cutting: telling real
 * code spans apart needs a full Markdown parser (escaped backticks, longer
 * backtick runs), and a cut can leave a span open. Inside a code span the
 * character is invisible.
 */
export function noMentions(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9])/g, '@\u200b');
}

export function agentText(text: string, max: number): string {
  const flat = replaceEmDashes(text)
    .replace(/<(?=\/?(?:details|summary)\b)/gi, '&lt;')
    .split('\n')
    .map((line) => line.replace(/^\s*#{1,6}\s+/, '').trim())
    .filter(Boolean)
    .join(' ');
  return noMentions(cutText(flat, max));
}

/** Free text from an agent that may run to several paragraphs: kept as lines, headings and tags neutralised, then cut. */
export function agentBlock(text: string, max: number): string {
  const lines = replaceEmDashes(text)
    .replace(/<(?=\/?(?:details|summary)\b)/gi, '&lt;')
    .split('\n')
    .map((line) => line.replace(/^\s*#{1,6}\s+/, '').trimEnd());
  return noMentions(cutText(lines.join('\n'), max));
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
  if (facts.dependenciesUnknown) return 'Not determined (the package files could not be read).';
  if (facts.dependencies.length === 0) return 'None';
  return facts.dependencies
    .map((d) =>
      d.change === 'added'
        ? `added ${codeSpan(d.name)} ${codeSpan(d.version, 60)}${d.dev ? ' (dev)' : ''} in ${codeSpan(d.file)}, licence per the lockfile: ${d.licence ? codeSpan(d.licence, 100) : 'unknown'}`
        : `removed ${codeSpan(d.name)}${d.dev ? ' (dev)' : ''} from ${codeSpan(d.file)}`,
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
    `- **Contracts:** ${facts ? (facts.contracts.length ? facts.contracts.map((c) => codeSpan(c)).join(', ') : 'None') : unknown}`,
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
    items.push(`${codeSpan(change.path)}: ${focusText(change.reason)}.`);
  }
  for (const path of facts?.contracts ?? []) {
    if (!sensitive.has(path)) items.push(`${codeSpan(path)}: changes a contract other components depend on.`);
  }
  if (review?.ok) {
    for (const severity of ['high', 'medium'] as const) {
      for (const f of review.review.findings) {
        if (f.severity !== severity || f.body.startsWith(GUARD_FINDING_PREFIX)) continue;
        items.push(`${codeSpan(f.line ? `${f.path}:${f.line}` : f.path)}: ${focusText(f.body)}`);
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
  return `- ${withSeverity ? `**${finding.severity}** ` : ''}${codeSpan(where)}: ${agentText(finding.body, 600)}`;
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
      '_The automated review did not complete. It is advisory, so it does not hold the pull request back; the details are under `review/` in the artefacts._',
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

const listPaths = (paths: readonly string[]): string => {
  const shown = paths.slice(0, MAX_LIST).map((p) => codeSpan(p)).join(', ');
  return paths.length > MAX_LIST ? `${shown} and ${paths.length - MAX_LIST} more` : shown;
};

/**
 * Tests: the CI result with its run, the test files the change touches (from
 * the diff), and what the builder says is not tested. The plan's `tests.add`
 * is what was planned, so it is labelled as that and collapsed.
 */
export function testsSection(test: TestResult, summary: BuilderSummary | undefined, facts: PrFacts | null | undefined, plan: PlanView | undefined): string {
  const result = test.skipped
    ? `**not verified**: ${skipText(test.skipped)}, so no automated tests ran on this change. Check it before merging.`
    : test.runUrl
      ? `[${test.outcome ?? 'run'}](${test.runUrl})`
      : 'not run';
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

/**
 * Run details: the metadata table, collapsed. Only values the orchestrator
 * knows; the artefact prefix without the bucket, which carries the account
 * ID. The trigger adapter reads the Branch row back for a comment in the
 * pull request's conversation, whose webhook does not carry the branch, so
 * its form is fixed (`| Branch | \`factorial/<id>\` |`); Prepare checks the
 * value against the pull request's real head.
 */
export function runDetailsSection(details: RunDetails, headSha: string): string {
  const rows: Array<[string, string]> = [
    ['Work item', `[${details.source.type} ${details.source.id}](${details.source.url})`],
    ['Requested by', `@${details.requestedBy}`],
    ['Branch', `\`${details.branch}\``],
    ['Head', `\`${headSha.slice(0, 12)}\``],
    ['Built by', `Factorial \`${details.factorialVersion.slice(0, 12)}\``],
    ['Session', `\`${details.sessionId}\``],
    ['Artefacts', `\`${details.artefactPrefix}\``],
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

/** The run details of a work context. */
export function runDetailsOf(ctx: WorkContext): RunDetails {
  const { source } = ctx.workItem;
  return {
    source: { type: source.type, id: source.id, url: source.url },
    requestedBy: ctx.workItem.requestedBy,
    branch: ctx.branch,
    factorialVersion: ctx.factorialVersion,
    sessionId: ctx.sessionId,
    artefactPrefix: ctx.artefactPrefix,
  };
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
    runDetailsSection(runDetailsOf(ctx), headSha),
  ].join('\n\n');
  // Whatever the sections let through, the body has no em or en dashes.
  return `${replaceEmDashes(body)}\n`;
}

/** A login as GitHub allows it (letters, digits, single hyphens, optional `[bot]`), or undefined for anything else. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/;

export function safeLogin(author: string): string | undefined {
  return GITHUB_LOGIN.test(author) ? author : undefined;
}

/** Who raised a point and where: a mention for a valid login, so the reviewer is told; anything else as a code span. */
function pointOrigin(detail: ReworkPoint): string {
  const login = safeLogin(detail.author);
  const who = login ? `@${login}` : codeSpan(detail.author, 60);
  const where = detail.path ? ` on ${codeSpan(detail.line === undefined ? detail.path : `${detail.path}:${detail.line}`)}` : '';
  return `${who}${where}`;
}

const MAX_REWORK_POINTS = 50;

/**
 * Each point the rework was asked to address, numbered as in rework.md, with
 * the builder's answer beside it. `points` is the list Prepare numbered
 * (with a review's inline comments); the work item's details for runs that
 * started before it recorded one.
 */
export function reworkPointsSection(rework: Pick<ReworkTurn, 'cause'>, points: readonly ReworkPoint[], summary: BuilderSummary | undefined): string {
  const heading = { review: '## Points raised', 'checks-failed': '## Failing checks', comment: '## Request' }[rework.cause];
  if (points.length === 0) {
    return [heading, '', '_No specific points were recorded for this rework._'].join('\n');
  }
  const lines = points.slice(0, MAX_REWORK_POINTS).map((detail, i) => {
    const answer = summary?.reworkPoints.get(i + 1);
    return `${i + 1}. ${pointOrigin(detail)}: ${answer ? agentText(answer, SUMMARY_CAPS.reworkNote) : NOT_REPORTED}`;
  });
  return [heading, '', ...lines].join('\n');
}

/** What the reply to a rework is built from, as OpenPullRequest knows it: stored in report.json for the reporter. */
export function reworkReplyFacts(
  ctx: WorkContext,
  rework: Pick<ReworkTurn, 'cause'>,
  summaryText: string,
  test: TestResult,
  headSha: string,
  extras: Pick<BodyExtras, 'review' | 'facts'> = {},
): ReworkReplyFacts {
  return {
    cause: rework.cause,
    requestedBy: ctx.workItem.requestedBy,
    headSha,
    test: { ...(test.runUrl ? { runUrl: test.runUrl } : {}), ...(test.outcome ? { outcome: test.outcome } : {}), ...(test.skipped ? { skipped: test.skipped } : {}) },
    points: ctx.reworkPoints ?? [],
    summaryText,
    ...(extras.review !== undefined ? { review: extras.review } : {}),
    ...(extras.facts !== undefined ? { facts: extras.facts } : {}),
    runDetails: runDetailsOf(ctx),
  };
}

/**
 * The reply to a rework request, posted on the pull request in place of a new
 * one. It answers each point, then gives the summary, the automated review
 * and the test result for the new head. The description is left as it was:
 * it describes the change as first opened, and this comment the rework.
 */
export function reworkComment(reply: ReworkReplyFacts): string {
  const { test, headSha, summaryText } = reply;
  const summary = parseBuilderSummary(summaryText);
  const requester = safeLogin(reply.requestedBy);
  const why = {
    review: 'the review',
    'checks-failed': 'the failing checks',
    comment: requester ? `the request from @${requester}` : 'the request in the conversation',
  }[reply.cause];
  // Only a run whose tests passed, or skipped them for want of a test workflow, reaches this reply.
  const tested = test.skipped ? 'it was **not verified**: no automated tests ran (see Tests below)' : test.runUrl ? `the [tests](${test.runUrl}) passed on it` : 'its tests passed';
  const body = [
    `Factorial has reworked this pull request after ${why}. The branch is now at \`${headSha.slice(0, 12)}\`, and ${tested}. The description above still describes the change as first opened; this comment covers the rework.`,
    reworkPointsSection(reply, reply.points, summary),
    summarySection(summary, summaryText, undefined),
    reviewSection(reply.review),
    testsSection(test, summary, reply.facts ?? null, undefined),
    runDetailsSection(reply.runDetails, headSha),
  ].join('\n\n');
  return `${replaceEmDashes(body)}\n`;
}
