/**
 * ContinueBuild: the builder stopped at its iteration or time limit before
 * finishing the plan, and Collect has saved its work to the branch. Set up
 * the next round: a fresh builder session (a new session id on the same
 * harness) cloned at the branch head, with the validated plan read back
 * from the artefact store, the previous round's notes (the builder's own
 * memory, stored by Collect before the push) and a section saying where
 * it stands. The state machine then runs the builder again.
 *
 * The old session is discarded. Nothing is read out of it here: what the
 * new round receives came from the artefact store or the branch.
 */
import { getTextArtefact, putJsonArtefact } from '@factorial/artefacts';

import type { WorkContext } from '../lib/context.ts';
import { MAX_NOTES_ARTEFACT_BYTES, builderSessionId, continuingSection, seedRoundScript } from '../lib/continue-files.ts';
import { logged, runKey } from '../lib/log.ts';
import { MAX_PLAN_ARTEFACT_BYTES } from '../lib/review-files.ts';
import { mustRun, sessionTarget } from '../lib/session.ts';
import { assertCommitSha } from '../lib/shell.ts';
import { recordProgress } from '../lib/table.ts';

import { initialNotes, seedSession } from './prepare.ts';

interface ContinueBuildInput {
  ctx: WorkContext;
  /** The round about to start: 2 for the first continuation. */
  round: number;
  /** What Collect saved from the previous round. */
  collect: { pushed: boolean; headSha: string; commitCount: number };
}

export interface ContinueBuildResult {
  sessionId: string;
  round: number;
}

async function artefact(ctx: WorkContext, path: string, maxBytes: number): Promise<string | undefined> {
  const read = await getTextArtefact(ctx.artefactPrefix, path, maxBytes);
  return read?.text;
}

export const handler = logged('continue-build', (input: ContinueBuildInput) => runKey(input.ctx), async (input, log): Promise<ContinueBuildResult> => {
  const { ctx, round, collect } = input;
  if (!Number.isInteger(round) || round < 2) throw new Error(`round ${round} is not a continuation round`);
  const sessionId = builderSessionId(ctx.workItem.id, round);

  const [planJson, planMarkdown, previousNotes] = await Promise.all([
    artefact(ctx, 'plan/plan.json', MAX_PLAN_ARTEFACT_BYTES),
    artefact(ctx, 'plan/plan.md', MAX_PLAN_ARTEFACT_BYTES),
    artefact(ctx, 'build/notes.md', MAX_NOTES_ARTEFACT_BYTES),
  ]);
  if (planJson === undefined || planMarkdown === undefined) throw new Error('the plan is not in the artefact store');
  if (previousNotes === undefined) log.error('previous notes not in the artefact store; starting the round from the initial notes');

  // The branch head the new round starts from: the pushed head when the
  // previous round committed anything, else the commit it started from. A
  // new item whose first round pushed nothing has no remote branch yet.
  const pushed = collect.pushed === true;
  const at = assertCommitSha(pushed ? collect.headSha : ctx.baseCommit, 'round start commit');
  await seedSession({
    role: 'builder',
    workItem: ctx.workItem,
    branch: ctx.branch,
    sessionId,
    at,
    existing: pushed || ctx.resumedFrom !== undefined,
    ...(ctx.resumedFrom ? { resumedFrom: ctx.resumedFrom } : {}),
  });

  const notes =
    (previousNotes ?? initialNotes(ctx.workItem, { role: 'builder', ...(ctx.resumedFrom ? { resumedFrom: ctx.resumedFrom } : {}) })) +
    continuingSection({ round, baseCommit: ctx.baseCommit, pushed, commitCount: collect.commitCount ?? 0 });
  await mustRun(sessionTarget(sessionId, 'builder'), seedRoundScript({ planJson, planMarkdown, notes }), 60);

  await putJsonArtefact(ctx.artefactPrefix, `build/round-${round}/continuing.json`, { sessionId, from: at, pushed, commitCount: collect.commitCount ?? 0 });
  await recordProgress(ctx.workItem.id, 'build-continuing', { buildRounds: round, buildSessionId: sessionId });
  log.info('build continues in a new session', { round, sessionId, from: at, pushed });
  return { sessionId, round };
});
