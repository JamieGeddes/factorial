import { createServices, type Services } from '../src/server/services.ts';
import type { LedgerRow, ThreadRow } from '../src/lib/records.ts';
import { stubClient, type StubClient } from './stubs.ts';
import type { Fetch } from '../src/server/github.ts';
import type { Upstream } from '../src/server/live.ts';

/** Services over stubbed clients: the ledger, threads and artefact store as given. */
export function stubServices(data: { rows?: LedgerRow[]; threads?: ThreadRow[]; objects?: Record<string, string>; now?: number; fetch?: Fetch } = {}): Services & { clients: Record<'cfn' | 'documents' | 's3' | 'control' | 'cw' | 'sfn' | 'ecs' | 'quotas' | 'logs' | 'ddb', StubClient> } {
  const rows = data.rows ?? [];
  const objects = data.objects ?? {};
  const clients = {
    cfn: stubClient({
      DescribeStacksCommand: (input) =>
        input.StackName === 'factorial-orchestration'
          ? { Stacks: [{ Outputs: [{ OutputKey: 'WorkArtefactsBucketName', OutputValue: 'bucket' }, { OutputKey: 'LiveHttpDomain', OutputValue: 'x.appsync-api.eu-west-1.amazonaws.com' }, { OutputKey: 'WorkStateMachineArn', OutputValue: 'arn:aws:states:eu-west-1:000000000000:stateMachine:factorial-work' }, { OutputKey: 'WorkStateMachineLiveAliasArn', OutputValue: 'arn:aws:states:eu-west-1:000000000000:stateMachine:factorial-work:live' }, { OutputKey: 'BuildClusterArn', OutputValue: 'arn:aws:ecs:eu-west-1:000000000000:cluster/factorial-build' }], Parameters: [{ ParameterKey: 'FactorialVersion', ParameterValue: '5e26e4e57cabd29f1703567b4a81d19b96a87ac8' }] }] }
          : { Stacks: [{ Outputs: [{ OutputKey: 'BuilderRuntimeId', OutputValue: 'factorial_builder-AbC123' }, { OutputKey: 'ReviewerRuntimeId', OutputValue: 'factorial_reviewer-XyZ789' }] }] },
    }),
    documents: stubClient({
      ScanCommand: (input) =>
        input.TableName === 'factorial-threads'
          ? { Items: data.threads ?? [] }
          : { Items: input.FilterExpression ? rows.filter((r) => r.result === undefined && (r.createdAt ?? '') >= '2026-10-31T13:22:52Z') : rows },
      GetCommand: (input) => {
        const key = input.Key as { workItemId?: string; threadKey?: string };
        return { Item: key.workItemId ? rows.find((r) => r.workItemId === key.workItemId) : data.threads?.find((t) => t.threadKey === key.threadKey) };
      },
    }),
    s3: stubClient({
      ListObjectsV2Command: (input) => ({ Contents: Object.keys(objects).filter((k) => k.startsWith(String(input.Prefix))).map((Key) => ({ Key, Size: objects[Key]?.length ?? 0 })) }),
      GetObjectCommand: (input) => {
        const text = objects[String(input.Key)];
        if (text === undefined) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return { Body: { transformToByteArray: async () => new TextEncoder().encode(text), transformToWebStream: () => new Response(text).body }, ContentType: 'text/html', ContentLength: text.length };
      },
    }),
    control: stubClient({
      GetAgentRuntimeEndpointCommand: (input) => ({ liveVersion: String(input.agentRuntimeId).startsWith('factorial_builder') ? '45' : '28', status: 'READY' }),
      ListAgentRuntimeVersionsCommand: (input) => ({ agentRuntimes: String(input.agentRuntimeId).startsWith('factorial_builder') ? [{ agentRuntimeVersion: '45', lastUpdatedAt: new Date('2026-10-30T18:00:00Z') }] : [] }),
    }),
    cw: stubClient({
      GetMetricDataCommand: (input) => ({ MetricDataResults: ((input.MetricDataQueries as { Id: string }[] | undefined) ?? []).map((q, i) => ({ Id: q.Id ?? (i === 0 ? 'rate' : undefined), Timestamps: [new Date('2026-11-01T09:00:00Z'), new Date('2026-11-01T09:01:00Z'), new Date('2026-11-01T09:02:00Z')], Values: [5, 10, 6] })) }),
      DescribeAlarmsCommand: () => ({ MetricAlarms: [] }),
    }),
    sfn: stubClient({
      ListExecutionsCommand: (input) => ({ executions: input.statusFilter === 'RUNNING' ? [{ startDate: new Date('2026-11-01T10:00:00Z') }] : [] }),
      DescribeStateMachineAliasCommand: () => ({ routingConfiguration: [{ stateMachineVersionArn: 'arn:aws:states:eu-west-1:000000000000:stateMachine:factorial-work:128', weight: 100 }] }),
    }),
    ecs: stubClient({ ListTasksCommand: () => ({ taskArns: ['arn:task/1'] }) }),
    quotas: stubClient({
      ListServiceQuotasCommand: () => ({ Quotas: [{ ServiceCode: 'bedrock', QuotaCode: 'L-31AB82D0', QuotaName: 'Global cross-region model inference tokens per minute for Anthropic Claude Sonnet 5.5', Value: 6_000_000 }] }),
      GetServiceQuotaCommand: (input) =>
        input.QuotaCode === 'L-3032A538'
          ? { Quota: { ServiceCode: 'fargate', QuotaCode: 'L-3032A538', QuotaName: 'Fargate On-Demand vCPU resource count', Value: 384, UsageMetric: { MetricNamespace: 'AWS/Usage', MetricName: 'ResourceCount', MetricDimensions: { Service: 'Fargate', Resource: 'vCPU' }, MetricStatisticRecommendation: 'Maximum' } } }
          : { Quota: { ServiceCode: String(input.ServiceCode), QuotaCode: String(input.QuotaCode), QuotaName: 'other', Value: 10 } },
    }),
    logs: stubClient({ StartQueryCommand: () => ({ queryId: 'q1' }), GetQueryResultsCommand: () => ({ status: 'Complete', results: [] }), StopQueryCommand: () => ({}) }),
    ddb: stubClient({ DescribeTableCommand: () => ({ Table: { ItemCount: 51 } }) }),
  };
  const upstream: Upstream = { current: 'idle', add() {}, remove() {} };
  const fetch: Fetch =
    data.fetch ??
    (async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ workflow_runs: [] }) }));
  const services = createServices(clients, { env: {}, upstream: () => upstream, fetch });
  return { ...services, now: () => data.now ?? Date.parse('2026-11-01T10:10:00Z'), clients };
}
