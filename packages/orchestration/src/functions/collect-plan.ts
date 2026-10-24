/**
 * CollectPlan: after the planner finishes, read its plan out of its session,
 * validate it against the plan contract and store it under `plan/`. A valid
 * plan is handed to the builder: this step clones the repository into the
 * builder's session at the commit the planner saw and writes the plan beside
 * it, so the builder only ever receives a plan that passed validation.
 *
 * An invalid or missing plan is retried once: the problems are appended to
 * the planner's notes and the state machine runs the planner again. A second
 * failure ends the run with `InvalidPlan`, reported to the requester.
 */
import { putArtefact, putJsonArtefact } from '@factorial/artefacts';

import type { WorkContext } from '../lib/context.ts';
import { logged, runKey } from '../lib/log.ts';
import { planSize } from '../lib/plan-size.ts';
import { checkPlanFiles, parsePlanRead, planDigest, readPlanScript, rejectionNotesScript, seedPlanScript, type PlanDigest } from '../lib/plan-files.ts';
import { handOverWorkspace, mustRun, sessionTarget } from '../lib/session.ts';
import { recordProgress } from '../lib/table.ts';

import { seedSession } from './prepare.ts';

/** How many times the planner runs before an invalid plan ends the run. */
export const MAX_PLAN_ATTEMPTS = 2;

export interface CollectPlanInput {
  ctx: WorkContext;
  /** 1 for the planner's first run, 2 for its retry. */
  planAttempt: number;
}

export type CollectPlanResult = { valid: true; plan: PlanDigest } | { valid: false; errors: string[] };

export class InvalidPlanError extends Error {
  constructor(errors: readonly string[]) {
    super(`The planner did not produce a valid plan in ${MAX_PLAN_ATTEMPTS} attempts:\n${errors.map((e) => `- ${e}`).join('\n')}`);
    this.name = 'InvalidPlan';
  }
}

/** What follows a check: hand the plan to the builder, run the planner again, or end the run. */
export function planOutcome(valid: boolean, planAttempt: number): 'accept' | 'retry' | 'fail' {
  if (valid) return 'accept';
  return planAttempt >= MAX_PLAN_ATTEMPTS ? 'fail' : 'retry';
}

export const handler = logged('collect-plan', (input: CollectPlanInput) => runKey(input.ctx), async (input, log): Promise<CollectPlanResult> => {
  const { ctx, planAttempt } = input;
  if (!Number.isInteger(planAttempt) || planAttempt < 1 || planAttempt > MAX_PLAN_ATTEMPTS) {
    throw new Error(`planAttempt ${planAttempt} is out of range`);
  }
  const planner = sessionTarget(ctx.sessionId, 'planner');
  const read = await mustRun(planner, readPlanScript(), 120);
  const checked = checkPlanFiles(parsePlanRead(read.stdout));
  // Recorded beside the builder's usage, so a plan's size can be set against what it cost.
  const size = checked.ok ? planSize(checked.plan) : undefined;

  // Stored whether or not the plan is valid, so a rejected plan can be read;
  // a retry overwrites the keys and versioning keeps the first attempt.
  if (checked.markdown !== undefined) await putArtefact(ctx.artefactPrefix, 'plan/plan.md', checked.markdown, 'text/markdown; charset=utf-8');
  if (checked.json !== undefined) await putArtefact(ctx.artefactPrefix, 'plan/plan.json', checked.json, 'application/json');
  await putJsonArtefact(ctx.artefactPrefix, 'plan/validation.json', {
    planAttempt,
    valid: checked.ok,
    ...(checked.ok ? { size } : { errors: checked.errors }),
  });

  if (!checked.ok) {
    await recordProgress(ctx.workItem.id, 'plan-rejected', { planAttempts: planAttempt, planErrors: checked.errors });
    log.error('plan rejected', { planAttempt, errors: checked.errors });
    if (planOutcome(false, planAttempt) === 'fail') throw new InvalidPlanError(checked.errors);
    await mustRun(planner, rejectionNotesScript(planAttempt, checked.errors), 60);
    return { valid: false, errors: checked.errors };
  }

  // The builder's session is set up only now: sessions close when idle, so
  // it could not have waited through planning.
  await seedSession({
    role: 'builder',
    workItem: ctx.workItem,
    branch: ctx.branch,
    at: ctx.baseCommit,
    ...(ctx.resumedFrom ? { resumedFrom: ctx.resumedFrom } : {}),
  });
  const builder = sessionTarget(ctx.sessionId, 'builder');
  await mustRun(builder, seedPlanScript(checked.markdown, checked.json), 60);
  await handOverWorkspace(builder);

  await recordProgress(ctx.workItem.id, 'plan-accepted', { planAttempts: planAttempt, planSteps: checked.plan.steps.length, planSize: size });
  log.info('plan accepted', { planAttempt, size });
  return { valid: true, plan: planDigest(checked.plan) };
});
