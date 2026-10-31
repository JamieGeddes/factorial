import 'server-only';

import type { ModelQuota, QuotaMeter } from '../lib/health.ts';
import { memo } from './cache.ts';
import { maxOf, metricData, sumOf, type MetricQuery } from './cloudwatch.ts';
import type { Sender } from './aws.ts';
import type { Config } from './config.ts';
import { runningTasks } from './ecs.ts';
import { ADAPTER_LOG_GROUP, insights, INVOKER_LOG_GROUP } from './logs.ts';
import { quota, quotasMatching, type Quota } from './quotas.ts';
import type { Stacks } from './stacks.ts';
import { stateMachineFacts, type StateMachineFacts } from './stepfunctions.ts';
import { tableFacts } from './table.ts';

/**
 * The Health view's AWS sources (#59), one memoised reader each: Lambda,
 * EventBridge, DynamoDB, S3 and Bedrock metrics in one `GetMetricData` call,
 * Step Functions, ECS, Service Quotas, `DescribeTable` and Logs Insights.
 * Every read uses the reviewer's credentials and writes nothing.
 */
export const ADAPTER_FUNCTION = 'factorial-github-issues-adapter';
const BUS = 'factorial-work';

export interface OpsClients {
  cw: Sender;
  sfn: Sender;
  ecs: Sender;
  quotas: Sender;
  logs: Sender;
  ddb: Sender;
}

export interface Ops {
  /** Lambda, bus, ledger and artefact store metrics, over the last 24 hours. */
  metrics(): Promise<{
    adapter: { invocations: number; errors: number };
    bus: { invocations: number; failed: number };
    ledger: { throttled: number };
    artefacts: { bytes?: number; objects?: number };
  }>;
  stateMachine(): Promise<StateMachineFacts>;
  invokerTasks(): Promise<number>;
  table(): Promise<{ items?: number; bytes?: number }>;
  /** Each model's peak tokens and requests per minute over the last hour against its quota. */
  models(ids: string[]): Promise<ModelQuota[]>;
  /** Fargate vCPU, Runtime sessions and the live feed's inbound events against their quotas. */
  quotas(): Promise<QuotaMeter[]>;
  deliveries(): Promise<{ hours: { at: number; outcome: string; n: number }[]; reasons: { reason: string; n: number }[] }>;
  retries(): Promise<{ model?: string; n: number }[]>;
}

const id = (s: string) => `q${s.replace(/[^A-Za-z0-9_]/g, '_')}`;

/** The quota name Service Quotas gives a model's cross-Region inference tokens per minute. */
export function tpmQuotaName(modelId: string): RegExp | undefined {
  const m = /^(global|eu|us|apac|jp|au)\.anthropic\.claude-([a-z]+)-(\d+)-(\d+)/.exec(modelId);
  if (!m) return undefined;
  const family = `${(m[2] as string).charAt(0).toUpperCase()}${(m[2] as string).slice(1)} ${m[3]}.${m[4]}`;
  return new RegExp(`^${m[1] === 'global' ? 'Global cross-region' : 'Cross-region'} model inference tokens per minute for Anthropic Claude ${family.replace('.', '\\.')}$`);
}

export function rpmQuotaName(modelId: string): RegExp | undefined {
  const tpm = tpmQuotaName(modelId);
  return tpm ? new RegExp(tpm.source.replace('tokens per minute', 'requests per minute')) : undefined;
}

/** Quotas with a usage metric the meters read: Fargate vCPU and AgentCore Runtime sessions. */
const QUOTAS = [
  { service: 'fargate', code: 'L-3032A538', label: 'Fargate vCPU' },
  { service: 'bedrock-agentcore', code: 'L-3E5722B2', label: 'Runtime sessions' },
];
/** Inbound events per API per second; Service Quotas names no metric, AppSync's `InboundMessages` counts them. */
const APPSYNC_INBOUND = { service: 'appsync', code: 'L-D91E563A', label: 'Live feed inbound events/s' };

export function createOps(clients: OpsClients, stacks: Stacks, config: () => Promise<Config>, now: () => number = Date.now): Ops {
  const hourAgo = () => new Date(now() - 3_600_000);

  const metrics = memo(async () => {
    const end = new Date(now());
    const start = new Date(end.getTime() - 86_400_000);
    const { bucket, workItemsTable } = await config();
    const queries: MetricQuery[] = [
      { id: 'adapterInv', namespace: 'AWS/Lambda', metric: 'Invocations', dimensions: { FunctionName: ADAPTER_FUNCTION, Resource: `${ADAPTER_FUNCTION}:live` }, stat: 'Sum', period: 3600 },
      { id: 'adapterErr', namespace: 'AWS/Lambda', metric: 'Errors', dimensions: { FunctionName: ADAPTER_FUNCTION, Resource: `${ADAPTER_FUNCTION}:live` }, stat: 'Sum', period: 3600 },
      { id: 'busInv', expression: `SUM(SEARCH('{AWS/Events,EventBusName,RuleName} MetricName="Invocations" EventBusName="${BUS}"', 'Sum', 3600))`, period: 3600 },
      { id: 'busFail', expression: `SUM(SEARCH('{AWS/Events,EventBusName,RuleName} MetricName="FailedInvocations" EventBusName="${BUS}"', 'Sum', 3600))`, period: 3600 },
      { id: 'throttled', expression: `SUM(SEARCH('{AWS/DynamoDB,TableName,Operation} MetricName="ThrottledRequests" TableName="${workItemsTable}"', 'Sum', 3600))`, period: 3600 },
    ];
    const daily: MetricQuery[] = [
      { id: 'size', namespace: 'AWS/S3', metric: 'BucketSizeBytes', dimensions: { BucketName: bucket, StorageType: 'StandardStorage' }, stat: 'Average', period: 86400 },
      { id: 'objects', namespace: 'AWS/S3', metric: 'NumberOfObjects', dimensions: { BucketName: bucket, StorageType: 'AllStorageTypes' }, stat: 'Average', period: 86400 },
    ];
    const [hourly, days] = await Promise.all([metricData(clients.cw, queries, start, end), metricData(clients.cw, daily, new Date(end.getTime() - 3 * 86_400_000), end)]);
    const last = (key: string) => {
      const v = days.get(key)?.values;
      return v && v.length ? v[v.length - 1] : undefined;
    };
    const size = last('size');
    const objects = last('objects');
    return {
      adapter: { invocations: sumOf(hourly.get('adapterInv')), errors: sumOf(hourly.get('adapterErr')) },
      bus: { invocations: sumOf(hourly.get('busInv')), failed: sumOf(hourly.get('busFail')) },
      ledger: { throttled: sumOf(hourly.get('throttled')) },
      artefacts: { ...(size !== undefined ? { bytes: size } : {}), ...(objects !== undefined ? { objects: Math.round(objects) } : {}) },
    };
  }, 60_000);

  const stateMachine = memo(async () => {
    const { outputs } = await stacks.orchestration();
    const arn = (await config()).stateMachineArn ?? outputs.WorkStateMachineArn;
    if (!arn) throw new Error('factorial-orchestration has no WorkStateMachineArn output');
    return stateMachineFacts(clients.sfn, arn, outputs.WorkStateMachineLiveAliasArn, new Date(new Date(now()).setHours(0, 0, 0, 0)).getTime());
  }, 60_000);

  const tasks = memo(async () => {
    const cluster = (await stacks.orchestration()).outputs.BuildClusterArn;
    if (!cluster) throw new Error('factorial-orchestration has no BuildClusterArn output');
    return runningTasks(clients.ecs, cluster);
  }, 60_000);

  const table = memo(async () => tableFacts(clients.ddb, (await config()).workItemsTable), 6 * 3_600_000);

  const bedrockQuotas = memo(() => quotasMatching(clients.quotas, 'bedrock', /(tokens|requests) per minute for Anthropic Claude/), 6 * 3_600_000);
  const fixedQuotas = memo(async () => {
    const all = await Promise.all([...QUOTAS, APPSYNC_INBOUND].map(async (q) => ({ ...q, quota: await quota(clients.quotas, q.service, q.code) })));
    return all;
  }, 6 * 3_600_000);

  const modelsCache = new Map<string, { at: number; value: Promise<ModelQuota[]> }>();
  const models = (ids: string[]): Promise<ModelQuota[]> => {
    const key = [...ids].sort().join(',');
    const hit = modelsCache.get(key);
    if (hit && now() - hit.at < 60_000) return hit.value;
    const value = (async () => {
      const known = await bedrockQuotas.get();
      const queries: MetricQuery[] = ids.flatMap((m) => [
        { id: id(`tpm_${m}`), namespace: 'AWS/Bedrock', metric: 'EstimatedTPMQuotaUsage', dimensions: { ModelId: m }, stat: 'Sum', period: 60 },
        { id: id(`rpm_${m}`), namespace: 'AWS/Bedrock', metric: 'Invocations', dimensions: { ModelId: m }, stat: 'Sum', period: 60 },
      ]);
      const data = await metricData(clients.cw, queries, hourAgo(), new Date(now()));
      return ids.map((m): ModelQuota => {
        const tpmName = tpmQuotaName(m);
        const rpmName = rpmQuotaName(m);
        const tpm = tpmName ? known.find((q: Quota) => tpmName.test(q.name)) : undefined;
        const rpm = rpmName ? known.find((q: Quota) => rpmName.test(q.name)) : undefined;
        return {
          model: m,
          ...(tpm ? { tpm: { peak: maxOf(data.get(id(`tpm_${m}`))) ?? 0, limit: tpm.value } } : {}),
          ...(rpm ? { rpm: { peak: maxOf(data.get(id(`rpm_${m}`))) ?? 0, limit: rpm.value } } : {}),
        };
      });
    })();
    modelsCache.set(key, { at: now(), value });
    value.catch(() => modelsCache.delete(key));
    return value;
  };

  const quotaMeters = memo(async (): Promise<QuotaMeter[]> => {
    const fixed = await fixedQuotas.get();
    const apiArn = (await stacks.orchestration()).outputs.LiveApiArn;
    const apiId = apiArn ? /:apis\/([a-z0-9]+)$/.exec(apiArn)?.[1] : undefined;
    const queries: MetricQuery[] = [];
    for (const f of fixed) {
      if (f.code === APPSYNC_INBOUND.code) {
        if (apiId) queries.push({ id: id(f.code), namespace: 'AWS/AppSync', metric: 'InboundMessages', dimensions: { EventAPIId: apiId }, stat: 'Sum', period: 60 });
      } else if (f.quota?.usage) {
        queries.push({ id: id(f.code), namespace: f.quota.usage.namespace, metric: f.quota.usage.metric, dimensions: f.quota.usage.dimensions, stat: f.quota.usage.stat, period: 60 });
      }
    }
    const data = await metricData(clients.cw, queries, hourAgo(), new Date(now()));
    return fixed.flatMap((f): QuotaMeter[] => {
      if (!f.quota || !queries.some((q) => q.id === id(f.code))) return [];
      const peak = maxOf(data.get(id(f.code))) ?? 0;
      const used = f.code === APPSYNC_INBOUND.code ? peak / 60 : peak;
      return [{ name: f.label, used, limit: f.quota.value, display: `${used < 10 && !Number.isInteger(used) ? used.toFixed(1) : Math.round(used).toLocaleString('en-GB')} / ${f.quota.value.toLocaleString('en-GB')}` }];
    });
  }, 60_000);

  const deliveries = memo(async () => {
    const end = new Date(now());
    const start = new Date(end.getTime() - 86_400_000);
    const [hours, reasons] = await Promise.all([
      insights(clients.logs, { groups: [ADAPTER_LOG_GROUP], query: "filter message = 'delivery' | stats count() as n by bin(1h) as hour, outcome", start, end }),
      insights(clients.logs, { groups: [ADAPTER_LOG_GROUP], query: "filter message = 'delivery' and outcome = 'ignored' | stats count() as n by reason | sort n desc | limit 50", start, end }),
    ]);
    return {
      hours: hours.flatMap((r) => {
        const at = Date.parse(`${(r.hour ?? '').replace(' ', 'T')}Z`);
        const n = Number(r.n);
        return Number.isFinite(at) && Number.isFinite(n) && r.outcome ? [{ at, outcome: r.outcome, n }] : [];
      }),
      reasons: reasons.flatMap((r) => (r.reason && Number.isFinite(Number(r.n)) ? [{ reason: r.reason, n: Number(r.n) }] : [])),
    };
  }, 60_000);

  const retries = memo(async () => {
    const end = new Date(now());
    const rows = await insights(clients.logs, {
      groups: [INVOKER_LOG_GROUP],
      query: "filter message = 'model call retried' | stats count() as n by runModel",
      start: new Date(end.getTime() - 15 * 60_000),
      end,
    });
    return rows.flatMap((r) => (Number.isFinite(Number(r.n)) ? [{ ...(r.runModel ? { model: r.runModel } : {}), n: Number(r.n) }] : []));
  }, 60_000);

  return {
    metrics: () => metrics.get(),
    stateMachine: () => stateMachine.get(),
    invokerTasks: () => tasks.get(),
    table: () => table.get(),
    models,
    quotas: () => quotaMeters.get(),
    deliveries: () => deliveries.get(),
    retries: () => retries.get(),
  };
}
