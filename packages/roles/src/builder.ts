/**
 * The builder: plans with its plan subagent, then changes the code on the
 * work item's branch, committing as it goes, and writes summary.md. It
 * continues in fresh sessions, up to MaxBuildRounds, when it runs out of
 * steps or time.
 */
import { buildPrompt } from './first-message.ts';
import type { RoleManifest } from './manifest.ts';

export const builder: RoleManifest = {
  name: 'builder',
  stage: 'build',
  statuses: { running: 'building', done: 'built', failed: 'build-error' },
  models: ['explore'],
  mustFinish: true,
  rounds: true,
  ledger: 'top-level',
  notesPlan:
    '_Your plan, from the plan subagent, goes in /workspace/plan.json and /workspace/plan.md: follow its steps in order by `id`. Keep a line here per step (done, part done, not started), and note any step you change or skip, and why._',
  firstMessage: (workItem, branch, baseBranch, options) => buildPrompt(workItem, branch, baseBranch, options.round ?? 1, options.resumed ?? false),
};
