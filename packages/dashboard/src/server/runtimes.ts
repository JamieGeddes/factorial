import 'server-only';

import { GetAgentRuntimeEndpointCommand } from '@aws-sdk/client-bedrock-agentcore-control';

import { memo } from './cache.ts';
import type { Sender } from './aws.ts';
import type { Stacks } from './stacks.ts';

/** Each role's Runtime and the version its `live` endpoint serves, from the agent stack's `*RuntimeId` outputs. */
export interface RuntimeVersion {
  /** `factorial_builder`, `factorial_reviewer`. */
  name: string;
  role: string;
  version?: string;
  status?: string;
}

export function runtimeNameOf(runtimeId: string): string {
  // A Runtime id is its name and a suffix: `factorial_builder-AbC123`.
  return runtimeId.replace(/-[A-Za-z0-9]+$/, '');
}

export function createRuntimes(control: Sender, stacks: Stacks, ttlMs = 60_000): { live(): Promise<RuntimeVersion[]> } {
  const live = memo(async () => {
    const { outputs } = await stacks.agent();
    const ids = Object.entries(outputs)
      .filter(([key]) => /^[A-Z][A-Za-z]*RuntimeId$/.test(key))
      .sort(([a], [b]) => a.localeCompare(b));
    return Promise.all(
      ids.map(async ([key, id]): Promise<RuntimeVersion> => {
        const role = key.replace(/RuntimeId$/, '').toLowerCase();
        const name = runtimeNameOf(id);
        try {
          const endpoint = (await control.send(new GetAgentRuntimeEndpointCommand({ agentRuntimeId: id, endpointName: 'live' }))) as { liveVersion?: string; status?: string };
          return { name, role, ...(endpoint.liveVersion ? { version: endpoint.liveVersion } : {}), ...(endpoint.status ? { status: endpoint.status } : {}) };
        } catch {
          return { name, role };
        }
      }),
    );
  }, ttlMs);
  return { live: () => live.get() };
}
