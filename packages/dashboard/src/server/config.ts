import 'server-only';

import type { Stacks } from './stacks.ts';

/**
 * Where everything is: from the environment, with defaults found from the
 * `factorial-orchestration` stack's outputs as `scripts/tail-run.ts` finds them.
 */
export interface Config {
  workItemsTable: string;
  threadsTable: string;
  bucket: string;
  liveHttpDomain: string;
  stateMachineArn?: string;
}

export type Env = Record<string, string | undefined>;

export function createConfig(stacks: Stacks, env: Env = process.env): () => Promise<Config> {
  let resolved: Promise<Config> | undefined;
  const resolve = async (): Promise<Config> => {
    let outputs: Record<string, string> = {};
    const needed = [env.FACTORIAL_LIVE_HTTP_DOMAIN, env.FACTORIAL_ARTEFACT_BUCKET, env.FACTORIAL_STATE_MACHINE_ARN];
    if (needed.some((v) => !v)) outputs = (await stacks.orchestration()).outputs;
    const bucket = env.FACTORIAL_ARTEFACT_BUCKET ?? outputs.WorkArtefactsBucketName;
    const liveHttpDomain = env.FACTORIAL_LIVE_HTTP_DOMAIN ?? outputs.LiveHttpDomain;
    if (!bucket || !liveHttpDomain) throw new Error('factorial-orchestration has no WorkArtefactsBucketName or LiveHttpDomain output');
    const stateMachineArn = env.FACTORIAL_STATE_MACHINE_ARN ?? outputs.WorkStateMachineArn;
    return {
      workItemsTable: env.FACTORIAL_WORK_ITEMS_TABLE ?? outputs.WorkItemsTableName ?? 'factorial-work-items',
      threadsTable: env.FACTORIAL_THREADS_TABLE ?? outputs.ThreadsTableName ?? 'factorial-threads',
      bucket,
      liveHttpDomain,
      ...(stateMachineArn ? { stateMachineArn } : {}),
    };
  };
  return () => {
    resolved ??= resolve();
    resolved.catch(() => (resolved = undefined));
    return resolved;
  };
}
