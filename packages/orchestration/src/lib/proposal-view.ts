/**
 * What a proposed plan's approver is shown (#169), and what an approval is
 * bound to. An approved build follows plan.json, so the comment shows
 * plan.json's steps, rendered here by the orchestrator from the validated
 * plan and never cut: a plan whose steps do not fit in a comment is not
 * proposed at all. plan.md is the planner's prose and goes beside them as
 * context only. The approval is bound to the plan.json that was shown by its
 * hash, which Report records on the proposal's ledger row and Prepare checks
 * before it seeds the approval's session.
 */
import { createHash } from 'node:crypto';

import type { Plan } from '@factorial/plan';

import { agentText, noMentions } from '../functions/pr-body.ts';
import { codeSpan } from './builder-summary.ts';

/** The most the rendered steps may take: with the comment's own text, inside GitHub's 65,536-character comment. */
export const PROPOSED_STEPS_CHARS = 45_000;

/** The hash an approval is bound to: SHA-256 of plan.json as stored. */
export function planSha256(json: string): string {
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

/**
 * plan.json as the approver reads it: the summary, each step with its files
 * and how it is checked, and the commands to run. Every field is shown in
 * full (each cap is twice the plan contract's maximum, room for the dash
 * replacements, so nothing is cut), on
 * one line, with no headings, tags or mentions.
 */
export function proposedSteps(plan: Plan): string {
  const lines = [agentText(plan.summary, 4000), ''];
  plan.steps.forEach((step, i) => {
    lines.push(`${i + 1}. \`${step.id}\`: ${agentText(step.description, 8000)}`);
    if (step.files.length > 0) lines.push(`   Files: ${step.files.map((file) => noMentions(codeSpan(file, 1000))).join(', ')}`);
    lines.push(`   Checked by: ${agentText(step.verification, 4000)}`);
  });
  if (plan.tests.run.length > 0) lines.push('', `Commands run once the change is made: ${plan.tests.run.map((command) => noMentions(codeSpan(command, 1000))).join(', ')}`);
  return lines.join('\n');
}

/** The proposal's plan.json is too large to show in full, so it cannot be proposed for approval. */
export class ProposalTooLargeError extends Error {
  constructor(chars: number) {
    super(`the plan's steps take ${chars} characters, over the ${PROPOSED_STEPS_CHARS} a proposal may show; nothing is proposed`);
    this.name = 'ProposalTooLarge';
  }
}
