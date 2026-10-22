/**
 * The size of a plan, recorded on the ledger row beside the builder's usage
 * so that what a plan asks for can be set against what the build cost. It is
 * a measurement, not a limit: a plan may be as large as the request needs,
 * and the builder continues across rounds until it is done.
 */
import type { Plan } from '@factorial/plan';

export interface PlanSize {
  steps: number;
  /** Distinct files across every step's `files`; a file several steps touch counts once. */
  files: number;
  /** Characters of step descriptions, summed. */
  descriptionChars: number;
  /** Items the planner left for a later work item. */
  followUp: number;
}

export function planSize(plan: Plan): PlanSize {
  return {
    steps: plan.steps.length,
    files: new Set(plan.steps.flatMap((step) => step.files)).size,
    descriptionChars: plan.steps.reduce((sum, step) => sum + step.description.length, 0),
    followUp: plan.followUp?.length ?? 0,
  };
}
