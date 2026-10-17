/**
 * Dispatch tests: start the repository's test workflow on the work branch,
 * handing it the Step Functions task token. The workflow reports back itself
 * through the callback role; this function returns nothing and the state
 * machine waits.
 */
import type { WorkContext } from '../lib/context.ts';
import { requireEnv } from '../lib/env.ts';
import { repositoryClient } from '../lib/github.ts';
import { recordProgress } from '../lib/table.ts';

interface DispatchInput {
  taskToken: string;
  ctx: WorkContext;
}

export const handler = async (input: DispatchInput): Promise<void> => {
  const { ctx } = input;
  const repo = { owner: ctx.workItem.repository.owner, name: ctx.workItem.repository.name };
  const client = await repositoryClient(repo, { actions: 'write' });
  await client.dispatchWorkflow(repo, requireEnv('TEST_WORKFLOW_FILE'), ctx.branch, {
    task_token: input.taskToken,
    work_item_id: ctx.workItem.id,
  });
  await recordProgress(ctx.workItem.id, 'testing');
  console.log(JSON.stringify({ message: 'test workflow dispatched', workItemId: ctx.workItem.id, branch: ctx.branch }));
};
