import type { WorkItem } from '@factorial/workitem';

import type { WorkContext } from '../lib/context.ts';
import type { DependencyChanges } from '../lib/dependency-changes.ts';
import type { PlanDigest } from '../lib/plan-files.ts';
import type { ReviewDigest, SensitiveChange } from '../lib/review-files.ts';

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

/** Word caps for the builder's sections: prompt guidance upstream, hard caps here. */
export const WORD_CAPS = { summary: 150, behaviour: 80, breaking: 80, uncertainties: 100, notTested: 60 } as const;

/** Take the text under a `## Heading` out of the builder's summary, capped to words, or undefined when it is missing or blank. */
export function sectionFromSummary(summary: string, heading: string, wordCap: number): string | undefined {
  const lines = summary.split('\n');
  const start = lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());
  if (start === -1) return undefined;
  const after = lines.slice(start + 1);
  const next = after.findIndex((line) => /^#{1,2} /.test(line));
  const text = (next === -1 ? after : after.slice(0, next)).join('\n').trim();
  if (!text) return undefined;
  return cutWords(text, wordCap);
}

const cutWords = (text: string, cap: number): string => {
  const words = text.split(/\s+/);
  return words.length > cap ? `${words.slice(0, cap).join(' ')} …` : text;
};

/** The builder's summary slot: its `## Summary`, or a fixed placeholder. */
export function summarySection(builderSummary: string, closes: string | undefined): string {
  const text = sectionFromSummary(builderSummary, '## Summary', WORD_CAPS.summary) ?? '_The builder did not write a summary._';
  const headed = `## Summary\n\n${text}`;
  return closes ? `${headed}\n\n${closes}` : headed;
}

export interface ImpactInputs {
  builderSummary: string;
  changedPaths?: string[] | undefined;
  dependencies?: DependencyChanges | undefined;
}

/** The Deploy bullet, computed from the changed paths: which templates change, and whether a human step is implied. */
export function deployImpact(changedPaths: readonly string[] | undefined): string {
  const templates = (changedPaths ?? []).filter((path) => /^templates\/.*\.ya?ml$/.test(path));
  if (templates.length === 0) return 'None — no CloudFormation template changes';
  const list = templates.map((path) => `\`${path}\``).join(', ');
  return templates.some((path) => /^templates\/00-/.test(path))
    ? `${list} — a foundation deploy is needed; review the diff before it runs`
    : `${list} — deployed by the deploy workflow after merge`;
}

/** The Contracts bullet, from the changed paths under contracts/. */
export function contractsImpact(changedPaths: readonly string[] | undefined): string | undefined {
  const contracts = (changedPaths ?? []).filter((path) => path.startsWith('contracts/'));
  return contracts.length ? contracts.slice(0, 10).map((path) => `\`${path}\``).join(', ') : undefined;
}

/** The Dependencies bullet, from Collect's dependency changes. */
export function dependenciesImpact(changes: DependencyChanges | undefined): string | undefined {
  if (!changes || (changes.added.length === 0 && changes.removed.length === 0)) return undefined;
  const lines = [
    ...changes.added.map((change) => `- added \`${change.name}\` (${change.licence ?? 'licence not recorded in the lockfile'})`),
    ...changes.removed.map((name) => `- removed \`${name}\``),
  ];
  return lines.join('\n');
}

/** The Impact section: all five bullets, every one present, `None` when it does not apply. */
export function impactSection(inputs: ImpactInputs): string {
  const behaviour = sectionFromSummary(inputs.builderSummary, '## Behaviour impact', WORD_CAPS.behaviour);
  const breaking = sectionFromSummary(inputs.builderSummary, '## Breaking changes', WORD_CAPS.breaking);
  const contracts = contractsImpact(inputs.changedPaths);
  const dependencies = dependenciesImpact(inputs.dependencies);
  return [
    '## Impact',
    '',
    `- **Behaviour:** ${behaviour ?? 'None'}`,
    `- **Deploy:** ${deployImpact(inputs.changedPaths)}`,
    `- **Contracts:** ${contracts ?? 'None'}`,
    `- **Dependencies:** ${dependencies ?? 'None'}`,
    `- **Breaking changes:** ${breaking ?? 'None'}`,
  ].join('\n');
}

/** Take the builder's account of each plan step out of its summary, so it sits with the plan. */
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
const cutSentence = (text: string, cap = 120): string => {
  const flat = text.replace(/\s*\n\s*/g, ' ').trim();
  const first = flat.split(/(?<=[.!?])\s/)[0] ?? flat;
  return first.length > cap ? `${first.slice(0, cap)}…` : first;
};

export interface ReviewFocusInputs {
  builderSummary: string;
  sensitive?: SensitiveChange[] | undefined;
  plan?: PlanDigest | undefined;
  review?: ReviewDigest | undefined;
}

/**
 * The Review focus section: at most five one-line items, most important
 * first — the sensitive paths the orchestrator detected, then the reviewer's
 * findings as short path-pointers, then the plan's open questions and a
 * pointer to the builder's uncertainties. Nothing is quoted twice.
 */
export function reviewFocusSection(inputs: ReviewFocusInputs): string {
  const items: string[] = [];
  const seen = new Set<string>();
  const add = (path: string, text: string): void => {
    if (seen.has(path) || items.length >= 5) return;
    seen.add(path);
    items.push(`- \`${path}\` — ${text}`);
  };
  for (const change of (inputs.sensitive ?? []).slice(0, 5)) add(change.path, change.reason);
  if (inputs.review) {
    for (const severity of ['high', 'medium'] as const) {
      for (const finding of inputs.review.findings.filter((f) => f.severity === severity)) {
        const where = finding.line ? `${finding.path}:${finding.line}` : finding.path;
        add(where, `${cutSentence(finding.body)} (${severity}, from the automated review)`);
      }
    }
  }
  for (const question of inputs.plan?.openQuestions ?? []) {
    if (items.length >= 5) break;
    items.push(`- ${cutSentence(question, 160)}`);
  }
  if (items.length < 5 && sectionFromSummary(inputs.builderSummary, '## Uncertainties', WORD_CAPS.uncertainties)) {
    items.push('- The builder flagged assumptions and things it could not verify: see `## Uncertainties` in its summary below.');
  }
  const body = items.length
    ? items.join('\n')
    : '_Nothing needs particular attention: no sensitive paths changed and the review raised no findings._';
  return `## Review focus\n\n${body}`;
}

/**
 * The Plan section: departures only in the open — steps the builder skipped
 * or changed, and reported lines matching no plan id — then the full step
 * list collapsed, never truncated. The plan's own summary paragraph is not
 * repeated here; `plan/plan.md` in the artefacts holds the full explanation.
 */
export function planSection(plan: PlanDigest, builderSteps: string | undefined): string {
  const lines = plan.steps.map((step) => (builderSteps ? stepLineFor(builderSteps, step.id) : undefined));
  const reported = builderSteps?.split('\n').map((line) => line.trim()).filter(Boolean) ?? [];
  const departures: string[] = [];
  const matched = new Set<string>();
  for (const [i, step] of plan.steps.entries()) {
    const line = lines[i];
    if (line === undefined) departures.push(`- \`${step.id}\` — not reported by the builder`);
    else {
      matched.add(line);
      if (/skipped|changed/i.test(line)) departures.push(`- ${line.replace(/^(?:[-*] )?/, '')}`);
    }
  }
  for (const line of reported) {
    if (!matched.has(line)) departures.push(`- ${line.replace(/^(?:[-*] )?/, '')} (reported, matches no plan step)`);
  }
  const list = plan.steps.map((step, i) => {
    const line = lines[i];
    return [`${i + 1}. \`${step.id}\`: ${step.description}`, ...(line ? [`   ${line.replace(/^(?:[-*] )?/, '- ')}`] : [])].join('\n');
  });
  const unreported = builderSteps && lines.every((line) => line === undefined) && reported.length > 0 ? ['', builderSteps] : [];
  return [
    '## Plan',
    '',
    ...(departures.length ? departures : [`All ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'} were done as planned.`]),
    ...(plan.steps.length || reported.length
      ? ['', '<details>', `<summary>Plan steps (${plan.steps.length})</summary>`, '', ...list, ...unreported, '', '</details>']
      : []),
  ].join('\n');
}

/** What the Review stage handed on: a review, the reason there is none, or nothing for runs before the stage existed. */
export type ReviewOutcome = { ok: true; review: ReviewDigest } | { ok: false; errors?: string[] } | null | undefined;

export function stepLineFor(steps: string, id: string): string | undefined {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^(?:[-*] |)?(?:\`${escaped}\`|${escaped})(?=[\\s:]|$)`);
  for (const line of steps.split('\n')) {
    if (pattern.test(line.trim())) return line.trim();
  }
  return undefined;
}

const VERDICTS: Record<ReviewDigest['verdict'], string> = {
  approve: 'Approve',
  'request-changes': 'Request changes',
  comment: 'Comment',
};

function findingLine(finding: ReviewDigest['findings'][number], withSeverity: boolean): string {
  const where = finding.line ? `${finding.path}:${finding.line}` : finding.path;
  const body = finding.body.replace(/\s*\n\s*/g, ' ');
  return `- ${withSeverity ? `**${finding.severity}** ` : ''}\`${where}\`: ${body}`;
}

/**
 * The automated review, advisory: verdict and scores on one line, the
 * summary, high-severity findings in the open and the rest collapsed. When
 * there is no valid review, a fixed sentence: the validation errors can quote
 * text from the reviewer's session, so they stay in the artefact store.
 */
export function reviewSection(outcome: Exclude<ReviewOutcome, undefined>): string {
  if (!outcome || !outcome.ok) {
    return [
      '## Automated review',
      '',
      '_The automated review did not complete. It is advisory, so the pull request was opened anyway; the details are under `review/` in the artefacts._',
    ].join('\n');
  }
  const { review } = outcome;
  const { correctness, completeness, tests, safety } = review.scores;
  const high = review.findings.filter((f) => f.severity === 'high');
  const other = review.findings.filter((f) => f.severity !== 'high');
  const omitted = review.totalFindings - review.findings.length;
  return [
    '## Automated review',
    '',
    `**${VERDICTS[review.verdict]}** · correctness ${correctness}/5 · completeness ${completeness}/5 · tests ${tests}/5 · safety ${safety}/5`,
    '',
    review.summary.trim(),
    ...(high.length ? ['', '**High severity**', '', ...high.map((f) => findingLine(f, false))] : []),
    ...(other.length
      ? ['', '<details>', `<summary>${other.length} other finding${other.length === 1 ? '' : 's'}</summary>`, '', ...other.map((f) => findingLine(f, true)), '', '</details>']
      : []),
    ...(omitted > 0 ? ['', `_${omitted} more finding${omitted === 1 ? '' : 's'} in \`review/review.json\` in the artefacts._`] : []),
    '',
    '_Advisory: the review does not block this pull request._',
  ].join('\n');
}

/** The Tests section: the outcome linked to the run, what the plan said to add, and what the builder left unverified. */
export function testsSection(test: TestResult, plan: PlanDigest | undefined, builderSummary: string): string {
  const outcome = test.runUrl ? `[${test.outcome ?? 'run'}](${test.runUrl})` : 'not run';
  const added = (plan?.testsAdd ?? []).map((t) => `- ${t}`);
  const notTested = sectionFromSummary(builderSummary, '## Not tested', WORD_CAPS.notTested);
  return [
    '## Tests',
    '',
    `Result: ${outcome}`,
    ...(added.length ? ['', 'Tests added:', '', ...added] : ['', '_The plan added no tests._']),
    '',
    notTested ?? 'Nothing was flagged as untested by the builder.',
  ].join('\n');
}

/** The Run details section: the metadata table, collapsed. */
export function runDetailsSection(ctx: WorkContext, test: TestResult, headSha: string): string {
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
  return ['<details>', '<summary>Run details</summary>', '', table, '', '</details>'].join('\n');
}

/** What the orchestrator computed for the body; absent for runs before these stages existed. */
export interface ComputedBodyInputs {
  changedPaths?: string[] | undefined;
  dependencies?: DependencyChanges | undefined;
  sensitive?: SensitiveChange[] | undefined;
}

/** The pull request body: what changed, what it affects, what needs attention, then the evidence. Each section is a pure function of its inputs, so a rework post (#24) can reuse them. */
export function pullRequestBody(
  ctx: WorkContext,
  summary: string,
  test: TestResult,
  headSha: string,
  plan?: PlanDigest,
  review?: ReviewOutcome,
  computed?: ComputedBodyInputs,
): string {
  const { rest, steps } = splitPlanSteps(summary);
  const closes = closingReference(ctx.workItem);
  const sections = [
    summarySection(rest, closes),
    impactSection({
      builderSummary: summary,
      changedPaths: computed?.changedPaths,
      dependencies: computed?.dependencies,
    }),
    reviewFocusSection({
      builderSummary: summary,
      sensitive: computed?.sensitive,
      plan,
      review: review?.ok ? review.review : undefined,
    }),
    ...(review !== undefined ? [reviewSection(review)] : []),
    testsSection(test, plan, summary),
    ...(plan ? [planSection(plan, steps)] : []),
    runDetailsSection(ctx, test, headSha),
  ];
  return `${sections.join('\n\n')}\n`;
}

