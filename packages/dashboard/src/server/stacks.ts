import 'server-only';

import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

import { memo } from './cache.ts';
import type { Sender } from './aws.ts';

export const ORCHESTRATION_STACK = 'factorial-orchestration';
export const AGENT_STACK = 'factorial-agent';

export interface StackFacts {
  outputs: Record<string, string>;
  parameters: Record<string, string>;
}

export interface Stacks {
  orchestration(): Promise<StackFacts>;
  agent(): Promise<StackFacts>;
}

async function describe(cfn: Sender, name: string): Promise<StackFacts> {
  const result = (await cfn.send(new DescribeStacksCommand({ StackName: name }))) as {
    Stacks?: Array<{ Outputs?: Array<{ OutputKey?: string; OutputValue?: string }>; Parameters?: Array<{ ParameterKey?: string; ParameterValue?: string }> }>;
  };
  const stack = result.Stacks?.[0];
  const outputs: Record<string, string> = {};
  const parameters: Record<string, string> = {};
  for (const o of stack?.Outputs ?? []) if (o.OutputKey && o.OutputValue !== undefined) outputs[o.OutputKey] = o.OutputValue;
  for (const p of stack?.Parameters ?? []) if (p.ParameterKey && p.ParameterValue !== undefined) parameters[p.ParameterKey] = p.ParameterValue;
  return { outputs, parameters };
}

/** The two stacks' outputs and parameters, read at most once a minute: a deploy changes them. */
export function createStacks(cfn: Sender, ttlMs = 60_000): Stacks {
  const orchestration = memo(() => describe(cfn, ORCHESTRATION_STACK), ttlMs);
  const agent = memo(() => describe(cfn, AGENT_STACK), ttlMs);
  return { orchestration: () => orchestration.get(), agent: () => agent.get() };
}
