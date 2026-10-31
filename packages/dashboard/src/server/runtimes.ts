import 'server-only';

import { GetAgentRuntimeEndpointCommand, ListAgentRuntimeVersionsCommand } from '@aws-sdk/client-bedrock-agentcore-control';

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

/** When each version of a role's Runtime was created (a version never changes after), by role then version. */
export type VersionTimes = Record<string, Record<string, string>>;

export interface Runtimes {
  live(): Promise<RuntimeVersion[]>;
  versions(): Promise<VersionTimes>;
}

async function runtimeIds(stacks: Stacks): Promise<[string, string][]> {
  const { outputs } = await stacks.agent();
  return Object.entries(outputs)
    .filter(([key]) => /^[A-Z][A-Za-z]*RuntimeId$/.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, id]) => [key.replace(/RuntimeId$/, '').toLowerCase(), id]);
}

export function createRuntimes(control: Sender, stacks: Stacks, ttlMs = 60_000): Runtimes {
  const versions = memo(async () => {
    const out: VersionTimes = {};
    for (const [role, id] of await runtimeIds(stacks)) {
      const times: Record<string, string> = {};
      let token: string | undefined;
      do {
        const page = (await control.send(new ListAgentRuntimeVersionsCommand({ agentRuntimeId: id, maxResults: 100, ...(token ? { nextToken: token } : {}) }))) as {
          agentRuntimes?: { agentRuntimeVersion?: string; lastUpdatedAt?: Date | string }[];
          nextToken?: string;
        };
        for (const v of page.agentRuntimes ?? []) {
          const at = v.lastUpdatedAt instanceof Date ? v.lastUpdatedAt.getTime() : Date.parse(String(v.lastUpdatedAt ?? ''));
          if (v.agentRuntimeVersion && Number.isFinite(at)) times[v.agentRuntimeVersion] = new Date(at).toISOString();
        }
        token = page.nextToken;
      } while (token);
      out[role] = times;
    }
    return out;
  }, 10 * ttlMs);
  const live = memo(async () => {
    const ids = await runtimeIds(stacks);
    return Promise.all(
      ids.map(async ([role, id]): Promise<RuntimeVersion> => {
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
  return { live: () => live.get(), versions: () => versions.get() };
}
