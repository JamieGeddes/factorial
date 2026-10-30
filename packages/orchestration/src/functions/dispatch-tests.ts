/**
 * Dispatch tests: start the repository's test workflow, handing it the Step
 * Functions task token. The workflow definition is taken from the default
 * branch, never from the work branch, so the agent cannot rewrite the gate;
 * the work commit is passed as an input and checked out as data.
 */
import type { WorkContext } from '../lib/context.ts';
import { requireEnv } from '../lib/env.ts';
import { repositoryClient } from '../lib/github.ts';
import { runKey } from '../lib/log.ts';
import { staged, type ProgressInput } from '../lib/progress.ts';
import { assertCommitSha } from '../lib/shell.ts';
import { recordProgress } from '../lib/table.ts';

interface DispatchInput extends ProgressInput {
  taskToken: string;
  ctx: WorkContext;
  collect: { headSha: string };
}

// The Test stage ends when the workflow reports back: PrepareReview records a pass, Report a failure.
export const handler = staged('dispatch-tests', (input: DispatchInput) => runKey(input.ctx), { endsLater: true }, async (input, log): Promise<void> => {
  const { ctx } = input;
  const sha = assertCommitSha(input.collect.headSha, 'head sha');
  const repo = { owner: ctx.workItem.repository.owner, name: ctx.workItem.repository.name };
  const client = await repositoryClient(repo, { actions: 'write' });
  await client.dispatchWorkflow(repo, requireEnv('TEST_WORKFLOW_FILE'), ctx.baseBranch, {
    task_token: input.taskToken,
    work_item_id: ctx.workItem.id,
    sha,
  });
  await recordProgress(ctx.workItem.id, 'testing', { testedSha: sha });
  log.info('test workflow dispatched', { sha });
});
