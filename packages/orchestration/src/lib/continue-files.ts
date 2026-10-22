/**
 * Continuing a build in a fresh session. A builder session has one context
 * that only grows and an iteration limit, so a plan can outlast it. When it
 * does, Collect saves the session's commits to the branch, and the build
 * continues in a new session (a new round) seeded from the branch with the
 * plan and the previous round's notes. The branch and the notes are the
 * memory between rounds; the old session is discarded, hostile like any
 * session an agent has run in.
 */
import { shellQuote } from './shell.ts';

/** The previous round's notes are read back from the artefact store at most this large. */
export const MAX_NOTES_ARTEFACT_BYTES = 64 * 1024;

/**
 * The builder's session id for a round. Round 1 is the work item id, as
 * every role's first session is; later rounds add a suffix, so each round
 * is a new session on the same harness.
 */
export function builderSessionId(workItemId: string, round: number): string {
  if (!Number.isInteger(round) || round < 1) throw new Error(`round ${round} is not a positive integer`);
  return round === 1 ? workItemId : `${workItemId}-r${round}`;
}

/**
 * The section the orchestrator appends to the carried-over notes, telling
 * the new session where it stands. The commit list is for the builder to
 * produce: it is the branch, not this text, that says what was done.
 */
export function continuingSection(params: { round: number; baseCommit: string; pushed: boolean; commitCount: number }): string {
  const { round, baseCommit, pushed, commitCount } = params;
  const state = pushed
    ? `Its ${commitCount === 1 ? 'commit is' : `${commitCount} commits are`} on this branch. If the last commit is "Save work in progress after the build failed", it holds whatever that session had not committed: check it, it may be unfinished.`
    : 'It committed nothing, so the branch is as it was at the start.';
  return [
    '',
    `# Continuing (round ${round})`,
    '',
    `This is round ${round} of the build for this work item. The previous session ran out of steps or time before finishing the plan. ${state} Its notes are above.`,
    '',
    'Before changing anything:',
    `1. Run \`git log --oneline ${baseCommit}..HEAD\` and \`git diff --stat ${baseCommit}...HEAD\` to see what is done.`,
    '2. Check each step in /workspace/plan.json against the commits and the notes, and record under "# Plan" which steps are done, which are part done, and which are not started.',
    '3. Carry on from the first step not done. Do not redo committed work.',
    '',
    'Commit after each step, and keep the step record under "# Plan" current: this session can end the same way, and the next one starts from the branch and this file.',
    '',
  ].join('\n');
}

/** Write the plan and the notes into the new round's session, over the clone's initial notes. */
export function seedRoundScript(params: { planJson: string; planMarkdown: string; notes: string }): string {
  const encode = (text: string): string => shellQuote(Buffer.from(text, 'utf8').toString('base64'));
  return [
    'set -euo pipefail',
    `printf '%s' ${encode(params.planJson)} | base64 -d > /workspace/plan.json`,
    `printf '%s' ${encode(params.planMarkdown)} | base64 -d > /workspace/plan.md`,
    `printf '%s' ${encode(params.notes)} | base64 -d > /workspace/notes.md`,
  ].join('\n');
}
