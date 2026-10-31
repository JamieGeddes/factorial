import 'server-only';

import { DescribeStateMachineAliasCommand, ListExecutionsCommand } from '@aws-sdk/client-sfn';

import type { Sender } from './aws.ts';

export interface StateMachineFacts {
  running: number;
  /** Executions that failed since local midnight. */
  failedToday: number;
  /** The version the `live` alias routes to. */
  liveVersion?: string;
}

type Execution = { startDate?: Date; stopDate?: Date };

async function count(sfn: Sender, stateMachineArn: string, statusFilter: string, since?: number): Promise<number> {
  let n = 0;
  let token: string | undefined;
  do {
    const page = (await sfn.send(new ListExecutionsCommand({ stateMachineArn, statusFilter: statusFilter as never, maxResults: 1000, ...(token ? { nextToken: token } : {}) }))) as {
      executions?: Execution[];
      nextToken?: string;
    };
    let older = false;
    for (const e of page.executions ?? []) {
      if (since === undefined) {
        n += 1;
        continue;
      }
      const at = (e.stopDate ?? e.startDate)?.getTime() ?? 0;
      if (at >= since) n += 1;
      // Newest first: once one started before the day, the rest did too.
      if ((e.startDate?.getTime() ?? 0) < since - 86_400_000) older = true;
    }
    token = older ? undefined : page.nextToken;
  } while (token);
  return n;
}

/** The state machine's running executions, today's failures and its `live` alias's version. */
export async function stateMachineFacts(sfn: Sender, stateMachineArn: string, aliasArn: string | undefined, startOfDay: number): Promise<StateMachineFacts> {
  const [running, failedToday, alias] = await Promise.all([
    count(sfn, stateMachineArn, 'RUNNING'),
    count(sfn, stateMachineArn, 'FAILED', startOfDay),
    aliasArn ? (sfn.send(new DescribeStateMachineAliasCommand({ stateMachineAliasArn: aliasArn })) as Promise<{ routingConfiguration?: { stateMachineVersionArn?: string; weight?: number }[] }>) : Promise.resolve(undefined),
  ]);
  const route = [...(alias?.routingConfiguration ?? [])].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];
  const version = route?.stateMachineVersionArn ? /:(\d+)$/.exec(route.stateMachineVersionArn)?.[1] : undefined;
  return { running, failedToday, ...(version ? { liveVersion: version } : {}) };
}
