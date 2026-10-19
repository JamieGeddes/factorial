/**
 * Which agent role this task runs. One task definition serves every role:
 * the state machine passes the role and its harness in the container
 * overrides, and this checks they belong together before anything is invoked.
 */
import type { WorkItem } from '@factorial/workitem';

import { buildPrompt } from './prompt.ts';

/** Roles the invoker knows how to start; each has a harness `factorial_<role>`. */
export const ROLES = ['builder'] as const;
export type Role = (typeof ROLES)[number];

export interface HarnessTarget {
  role: Role;
  harnessArn: string;
  harnessId: string;
  /** The endpoint invoked, `live` in normal running. */
  qualifier: string;
}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Read and check the role and harness from the task's environment. */
export function harnessTarget(env: Record<string, string | undefined>): HarnessTarget {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing required environment variable ${name}`);
    return value;
  };
  const role = required('ROLE');
  if (!isRole(role)) throw new Error(`Unknown agent role "${role}"`);
  const harnessId = required('HARNESS_ID');
  if (!new RegExp(`^factorial_${role}-[A-Za-z0-9]+$`).test(harnessId)) {
    throw new Error(`Harness ${harnessId} is not the ${role} harness`);
  }
  const harnessArn = required('HARNESS_ARN');
  if (!/^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:[0-9]{12}:harness\//.test(harnessArn) || !harnessArn.endsWith(`:harness/${harnessId}`)) {
    throw new Error(`HARNESS_ARN does not name harness ${harnessId}`);
  }
  const qualifier = required('HARNESS_QUALIFIER');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(qualifier)) throw new Error(`"${qualifier}" is not an endpoint name`);
  return { role, harnessArn, harnessId, qualifier };
}

/** The user message that starts a session for the role. */
export function promptFor(role: Role, workItem: WorkItem, branch: string, baseBranch: string): string {
  switch (role) {
    case 'builder':
      return buildPrompt(workItem, branch, baseBranch);
  }
}
