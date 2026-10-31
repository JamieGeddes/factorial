import 'server-only';

import { ListTasksCommand } from '@aws-sdk/client-ecs';

import type { Sender } from './aws.ts';

/** The invoker's running Fargate tasks in its cluster. */
export async function runningTasks(ecs: Sender, cluster: string): Promise<number> {
  let n = 0;
  let token: string | undefined;
  do {
    const page = (await ecs.send(new ListTasksCommand({ cluster, desiredStatus: 'RUNNING', maxResults: 100, ...(token ? { nextToken: token } : {}) }))) as { taskArns?: string[]; nextToken?: string };
    n += page.taskArns?.length ?? 0;
    token = page.nextToken;
  } while (token);
  return n;
}
