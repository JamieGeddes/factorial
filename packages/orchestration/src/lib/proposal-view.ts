/**
 * What a proposed plan's approver is shown (#169), and what an approval is
 * bound to. An approved build is given plan.json and nothing else of the
 * planner's, so the comment shows every field of plan.json, whole, and an
 * approved build's plan.md is this same text, written by the orchestrator:
 * the build sees only what the approver read.
 *
 * The view is plain text in a code fence longer than any backtick run in it,
 * so GitHub shows it literally: no HTML (an HTML comment cannot hide a
 * step), no Markdown, no links. Invisible, bidirectional and control
 * characters are removed first, so nothing reads differently from what it
 * is, and mentions are broken. A plan whose view does not fit in a comment
 * is not proposed. The approval is bound to the plan.json that was shown by
 * its hash, which Report records on the proposal's ledger row and Prepare
 * checks before it seeds the approval's session.
 */
import { createHash } from 'node:crypto';

import type { Plan } from '@factorial/plan';

import { noMentions } from '../functions/pr-body.ts';

/** The most the rendered view may take: with the comment's own text, inside GitHub's 65,536-character comment. */
export const PROPOSED_STEPS_CHARS = 45_000;

/** The hash an approval is bound to: SHA-256 of plan.json as stored. */
export function planSha256(json: string): string {
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

/**
 * Characters that render as nothing, render differently from what they are,
 * or reorder text: format characters (zero-width, bidirectional controls,
 * soft hyphen, BOM, tag characters), controls other than newline and tab,
 * private-use and unassigned code points, variation selectors and the
 * Hangul fillers. Written as escapes, so this file holds none of them.
 */
const HIDDEN_SOURCE = String.raw`(?![\n\t])[\p{Cf}\p{Cc}\p{Co}\p{Cn}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{115F}\u{1160}\u{3164}\u{FFA0}]`;
const HIDDEN = new RegExp(HIDDEN_SOURCE, 'gu');
const HAS_HIDDEN = new RegExp(HIDDEN_SOURCE, 'u');

/** Every string in a parsed value, keys included: what the build reads, escapes decoded. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([key, v]) => [key, ...strings(v)]);
  return [];
}

/** Whether any text in the plan holds a hidden character: such a plan is neither proposed nor built, so what is shown is all there is. */
export function hasHiddenCharacters(plan: Plan): boolean {
  return strings(plan).some((text) => HAS_HIDDEN.test(text));
}

/** The plan.json an approved build is given: the validated plan re-serialised, so it reads exactly as the parsed plan that was shown (no duplicate keys, no escapes). */
export function canonicalPlanJson(plan: Plan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

/** The plan holds hidden characters, so it cannot be shown as it is and is not proposed. */
export class ProposalHiddenTextError extends Error {
  constructor() {
    super('the plan holds invisible, bidirectional or control characters, so it cannot be shown as it is; nothing is proposed');
    this.name = 'ProposalHiddenText';
  }
}

/** Agent text as it is shown: hidden characters removed, line endings unified, mentions broken. */
export function visible(text: string): string {
  return noMentions(text.replace(/\r\n?/g, '\n').replace(HIDDEN, '').trim());
}

function indented(text: string, prefix: string): string[] {
  return visible(text)
    .split('\n')
    .map((line) => `${prefix}${line}`);
}

function list(title: string, items: readonly string[]): string[] {
  if (items.length === 0) return [];
  return ['', `${title}:`, ...items.flatMap((item) => indented(item, '  - ').map((line, i) => (i === 0 ? line : `    ${line.slice(4)}`)))];
}

/**
 * Every field of plan.json, as plain text, nothing cut: the summary, each
 * step with its files and check, the tests to run and add, the risks, the
 * open questions and the follow-up work.
 */
export function planText(plan: Plan): string {
  const lines = ['Summary:', ...indented(plan.summary, '  ')];
  plan.steps.forEach((step, i) => {
    lines.push('', `Step ${i + 1}: ${visible(step.id)}`, ...indented(step.description, '  '));
    if (step.files.length > 0) lines.push('  Files:', ...step.files.flatMap((file) => indented(file, '    - ')));
    lines.push('  Checked by:', ...indented(step.verification, '    '));
  });
  lines.push(
    ...list('Commands run once the change is made', plan.tests.run),
    ...list('Tests to add or change', plan.tests.add),
    ...list('Risks', plan.risks),
    ...list('Open questions, with the assumption made', plan.openQuestions),
    ...list('Left for a later work item', plan.followUp ?? []),
  );
  return lines.join('\n');
}

/** A code fence longer than any backtick run in the text, so the text cannot close it. */
export function fenced(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** The approver's view of plan.json: the whole plan, shown literally. */
export function proposedSteps(plan: Plan): string {
  return fenced(planText(plan));
}

/** An approved build's plan.md: the text its approver read, written by the orchestrator, not the planner's prose. */
export function approvedPlanMarkdown(plan: Plan, proposalId: string): string {
  return [
    '# Approved plan',
    '',
    `Written by the orchestrator from the plan.json proposed by work item ${proposalId} and approved by the requester: the text the requester read. plan.json is the plan; follow its steps by id.`,
    '',
    planText(plan),
    '',
  ].join('\n');
}

/** The proposal's plan.json is too large to show in full, so it cannot be proposed for approval. */
export class ProposalTooLargeError extends Error {
  constructor(chars: number) {
    super(`the plan takes ${chars} characters to show, over the ${PROPOSED_STEPS_CHARS} a proposal may show; nothing is proposed`);
    this.name = 'ProposalTooLarge';
  }
}
