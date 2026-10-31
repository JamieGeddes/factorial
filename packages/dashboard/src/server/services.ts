import 'server-only';

import { BedrockAgentCoreControlClient } from '@aws-sdk/client-bedrock-agentcore-control';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ECSClient } from '@aws-sdk/client-ecs';
import { S3Client } from '@aws-sdk/client-s3';
import { ServiceQuotasClient } from '@aws-sdk/client-service-quotas';
import { SFNClient } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { connectAuthorization, connectProtocols, realtimeDomainOf, subscribeAuthorization, type LiveEndpoint } from '@factorial/live';

import { parseStageKey } from '../lib/stage-key.ts';
import { createArtefacts, type Artefacts } from './artefacts.ts';
import { REGION, type Sender } from './aws.ts';
import { createCloudWatch, type AlarmDetail, type Alarms } from './cloudwatch.ts';
import { createConfig, type Config, type Env } from './config.ts';
import { createGitHub, type Fetch, type GitHub } from './github.ts';
import { createLedger, type Ledger } from './ledger.ts';
import { LiveConnection, type SocketLike } from './live-connection.ts';
import { LiveHub } from './live.ts';
import { createOps, type Ops } from './ops.ts';
import { createRuntimes, type Runtimes } from './runtimes.ts';
import { createStacks, type Stacks } from './stacks.ts';
import { createThreads, type Threads } from './threads.ts';
import { createUsageRecords, type UsageRecords } from './usage-records.ts';

/**
 * Every source the views read, built once per server process. Credentials
 * come from the AWS SDK's default chain: the reviewer's profile here, a task
 * role on Fargate, with no code change.
 */
export interface Services {
  config: () => Promise<Config>;
  stacks: Stacks;
  ledger: Ledger;
  threads: Threads;
  artefacts: Artefacts;
  runtimes: Runtimes;
  cloudwatch: { busRate(): Promise<number>; alarms(): Promise<Alarms>; alarmDetails(): Promise<AlarmDetail[]> };
  /** Each run's `usage.json` facts (#59). */
  usage: UsageRecords;
  /** The Health view's AWS sources (#59). */
  ops: Ops;
  /** The deploy workflow's runs on Factorial's own repository (#59). */
  github: GitHub;
  live: LiveHub;
  now: () => number;
}

export interface Clients {
  cfn: Sender;
  documents: Sender;
  s3: Sender;
  control: Sender;
  cw: Sender;
  sfn: Sender;
  ecs: Sender;
  quotas: Sender;
  logs: Sender;
  ddb: Sender;
}

/** Factorial's own repository, where `FactorialVersion` is a commit and the deploy workflow runs. */
export const FACTORIAL_REPOSITORY = 'JamieGeddes/factorial';

/** Whether the ledger says a run, or its whole item, has ended. */
export async function runOver(ledger: Ledger, workItemId: string, stage: string, round: number): Promise<boolean> {
  const row = await ledger.get(workItemId);
  if (!row) return false;
  if (typeof row.result === 'string') return true;
  if (row.live?.stage === stage && (row.live.round ?? 1) === round && row.live.ended) return true;
  for (const [key, entry] of Object.entries(row.stages ?? {})) {
    const parsed = parseStageKey(key);
    if (parsed.stage.toLowerCase() === stage && (parsed.round ?? 1) === round && entry?.endedAt) return true;
  }
  return false;
}

export function createServices(clients: Clients, options: { env?: Env; upstream?: ConstructorParameters<typeof LiveHub>[0]['upstream']; fetch?: Fetch } = {}): Services {
  const env = options.env ?? process.env;
  const stacks = createStacks(clients.cfn);
  const config = createConfig(stacks, options.env);
  const ledger = createLedger(clients.documents, { table: async () => (await config()).workItemsTable });
  const threads = createThreads(clients.documents, async () => (await config()).threadsTable);
  const artefacts = createArtefacts(clients.s3, async () => (await config()).bucket);
  const endpoint = async (): Promise<LiveEndpoint> => ({ httpDomain: (await config()).liveHttpDomain, region: REGION });
  const log = (message: string) => console.error(message);
  const live = new LiveHub({
    upstream:
      options.upstream ??
      ((handlers) =>
        new LiveConnection({
          url: async () => `wss://${realtimeDomainOf((await endpoint()).httpDomain)}/event/realtime`,
          socket: (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike,
          auth: {
            protocols: async () => connectProtocols(await connectAuthorization(await endpoint())),
            subscribe: async (channel) => subscribeAuthorization(await endpoint(), channel),
          },
          log,
          ...handlers,
        })),
    chunk: (key) => artefacts.chunk(key),
    attemptOf: async (id) => (await ledger.get(id))?.attempt,
    runOver: (id, stage, round) => runOver(ledger, id, stage, round),
    log,
  });
  return {
    config,
    stacks,
    ledger,
    threads,
    artefacts,
    runtimes: createRuntimes(clients.control, stacks),
    cloudwatch: createCloudWatch(clients.cw),
    usage: createUsageRecords(artefacts),
    ops: createOps(clients, stacks, config),
    github: createGitHub({ repository: env.FACTORIAL_REPOSITORY ?? FACTORIAL_REPOSITORY, token: env.GITHUB_TOKEN, ...(options.fetch ? { fetch: options.fetch } : {}) }),
    live,
    now: Date.now,
  };
}

const KEY = Symbol.for('factorial.dashboard.services');

/**
 * Ends the live streams when the process is asked to stop. `next start`
 * stops accepting connections on a signal and waits for the open ones, and a
 * tab's stream never ends by itself, so without this the server never exits.
 * It does not exit the process: Next.js's own handlers do that once the
 * streams have ended (and the launcher force-stops it after 5 seconds if not).
 * The hub holds only read-only state, so closing it loses nothing.
 */
export function closeOnSignals(live: { close(): void }, proc: { once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown }): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) proc.once(signal, () => live.close());
}

/** The process's services: one set however often Next.js loads this module. */
export function services(): Services {
  const holder = globalThis as unknown as Record<symbol, Services | undefined>;
  if (!holder[KEY]) {
    const created = createServices({
      cfn: new CloudFormationClient({ region: REGION }),
      documents: DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION })),
      s3: new S3Client({ region: REGION }),
      control: new BedrockAgentCoreControlClient({ region: REGION }),
      cw: new CloudWatchClient({ region: REGION }),
      sfn: new SFNClient({ region: REGION }),
      ecs: new ECSClient({ region: REGION }),
      quotas: new ServiceQuotasClient({ region: REGION }),
      logs: new CloudWatchLogsClient({ region: REGION }),
      ddb: new DynamoDBClient({ region: REGION }),
    });
    closeOnSignals(created.live, process);
    holder[KEY] = created;
  }
  return holder[KEY];
}
