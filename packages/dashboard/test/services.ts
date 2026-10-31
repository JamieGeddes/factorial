import { createServices, type Services } from '../src/server/services.ts';
import type { LedgerRow, ThreadRow } from '../src/lib/records.ts';
import { stubClient, type StubClient } from './stubs.ts';
import type { Upstream } from '../src/server/live.ts';

/** Services over stubbed clients: the ledger, threads and artefact store as given. */
export function stubServices(data: { rows?: LedgerRow[]; threads?: ThreadRow[]; objects?: Record<string, string>; now?: number } = {}): Services & { clients: Record<'cfn' | 'documents' | 's3' | 'control' | 'cw', StubClient> } {
  const rows = data.rows ?? [];
  const objects = data.objects ?? {};
  const clients = {
    cfn: stubClient({
      DescribeStacksCommand: (input) =>
        input.StackName === 'factorial-orchestration'
          ? { Stacks: [{ Outputs: [{ OutputKey: 'WorkArtefactsBucketName', OutputValue: 'bucket' }, { OutputKey: 'LiveHttpDomain', OutputValue: 'x.appsync-api.eu-west-1.amazonaws.com' }], Parameters: [{ ParameterKey: 'FactorialVersion', ParameterValue: '5e26e4e57cabd29f1703567b4a81d19b96a87ac8' }] }] }
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
    control: stubClient({ GetAgentRuntimeEndpointCommand: (input) => ({ liveVersion: String(input.agentRuntimeId).startsWith('factorial_builder') ? '45' : '28', status: 'READY' }) }),
    cw: stubClient({
      GetMetricDataCommand: () => ({ MetricDataResults: [{ Values: [5, 10, 6] }] }),
      DescribeAlarmsCommand: () => ({ MetricAlarms: [] }),
    }),
  };
  const upstream: Upstream = { current: 'idle', add() {}, remove() {} };
  const services = createServices(clients, { env: {}, upstream: () => upstream });
  return { ...services, now: () => data.now ?? Date.parse('2026-11-01T10:10:00Z'), clients };
}
