import 'server-only';

import { DescribeAlarmsCommand, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';

import { memo } from './cache.ts';
import type { Sender } from './aws.ts';

export const BUS_NAME = 'factorial-work';
export const ALARM_PREFIX = 'factorial-';

export interface Alarms {
  /** Alarms named `factorial-*`. */
  total: number;
  /** Those in `ALARM`, by name. */
  firing: string[];
  /** When each alarm in `firing` entered it. */
  since: Record<string, string>;
}

/** Events per minute on the bus, over the last ten whole minutes: the sum of its rules' invocations. */
export async function busRate(cw: Sender, now: Date): Promise<number> {
  const end = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const start = new Date(end.getTime() - 10 * 60_000);
  const result = (await cw.send(
    new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: [
        {
          Id: 'rate',
          Expression: `SUM(SEARCH('{AWS/Events,EventBusName,RuleName} MetricName="Invocations" EventBusName="${BUS_NAME}"', 'Sum', 60))`,
          Period: 60,
          ReturnData: true,
        },
      ],
    }),
  )) as { MetricDataResults?: Array<{ Values?: number[] }> };
  const values = result.MetricDataResults?.[0]?.Values ?? [];
  return values.reduce((a, b) => a + b, 0) / 10;
}

type Alarm = { AlarmName?: string; StateValue?: string; StateUpdatedTimestamp?: Date };

export async function alarms(cw: Sender): Promise<Alarms> {
  let total = 0;
  const firing: string[] = [];
  const since: Record<string, string> = {};
  let token: string | undefined;
  do {
    const page = (await cw.send(
      new DescribeAlarmsCommand({ AlarmNamePrefix: ALARM_PREFIX, AlarmTypes: ['MetricAlarm', 'CompositeAlarm'], ...(token ? { NextToken: token } : {}) }),
    )) as { MetricAlarms?: Array<Alarm>; CompositeAlarms?: Array<Alarm>; NextToken?: string };
    for (const alarm of [...(page.MetricAlarms ?? []), ...(page.CompositeAlarms ?? [])]) {
      total += 1;
      if (alarm.StateValue === 'ALARM' && alarm.AlarmName) {
        firing.push(alarm.AlarmName);
        const at = alarm.StateUpdatedTimestamp;
        if (at instanceof Date && Number.isFinite(at.getTime())) since[alarm.AlarmName] = at.toISOString();
      }
    }
    token = page.NextToken;
  } while (token);
  return { total, firing, since };
}

/** One alarm as the Health view lists it (#59). */
export interface AlarmDetail {
  name: string;
  state: string;
  reason?: string;
  updatedAt?: string;
}

/** Every `factorial-*` alarm with its state and reason, firing first. */
export async function alarmDetails(cw: Sender): Promise<AlarmDetail[]> {
  const out: AlarmDetail[] = [];
  let token: string | undefined;
  do {
    const page = (await cw.send(
      new DescribeAlarmsCommand({ AlarmNamePrefix: ALARM_PREFIX, AlarmTypes: ['MetricAlarm', 'CompositeAlarm'], ...(token ? { NextToken: token } : {}) }),
    )) as { MetricAlarms?: Array<Alarm & { StateReason?: string }>; CompositeAlarms?: Array<Alarm & { StateReason?: string }>; NextToken?: string };
    for (const alarm of [...(page.MetricAlarms ?? []), ...(page.CompositeAlarms ?? [])]) {
      if (!alarm.AlarmName) continue;
      const at = alarm.StateUpdatedTimestamp;
      out.push({
        name: alarm.AlarmName,
        state: alarm.StateValue ?? 'INSUFFICIENT_DATA',
        ...(alarm.StateReason ? { reason: alarm.StateReason } : {}),
        ...(at instanceof Date && Number.isFinite(at.getTime()) ? { updatedAt: at.toISOString() } : {}),
      });
    }
    token = page.NextToken;
  } while (token);
  const rank = (state: string) => (state === 'ALARM' ? 0 : state === 'INSUFFICIENT_DATA' ? 1 : 2);
  return out.sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));
}

/** One metric query: a plain metric, or an expression such as `SUM(SEARCH(...))`. */
export type MetricQuery =
  | { id: string; namespace: string; metric: string; dimensions: Record<string, string>; stat: string; period: number }
  | { id: string; expression: string; period: number };

/** A query's datapoints, oldest first. */
export interface MetricSeries {
  timestamps: number[];
  values: number[];
}

/**
 * Many metrics in one `GetMetricData` call (up to 500 queries), each by its
 * id. A query with no data reads as an empty series, never an error.
 */
export async function metricData(cw: Sender, queries: MetricQuery[], start: Date, end: Date): Promise<Map<string, MetricSeries>> {
  const out = new Map<string, MetricSeries>();
  for (const q of queries) out.set(q.id, { timestamps: [], values: [] });
  if (queries.length === 0) return out;
  for (let i = 0; i < queries.length; i += 500) {
    const batch = queries.slice(i, i + 500);
    let token: string | undefined;
    do {
      const result = (await cw.send(
        new GetMetricDataCommand({
          StartTime: start,
          EndTime: end,
          ScanBy: 'TimestampAscending',
          MetricDataQueries: batch.map((q) =>
            'expression' in q
              ? { Id: q.id, Expression: q.expression, Period: q.period, ReturnData: true }
              : {
                  Id: q.id,
                  MetricStat: { Metric: { Namespace: q.namespace, MetricName: q.metric, Dimensions: Object.entries(q.dimensions).map(([Name, Value]) => ({ Name, Value })) }, Period: q.period, Stat: q.stat },
                  ReturnData: true,
                },
          ),
          ...(token ? { NextToken: token } : {}),
        }),
      )) as { MetricDataResults?: Array<{ Id?: string; Timestamps?: Date[]; Values?: number[] }>; NextToken?: string };
      for (const r of result.MetricDataResults ?? []) {
        const series = r.Id ? out.get(r.Id) : undefined;
        if (!series) continue;
        (r.Timestamps ?? []).forEach((t, n) => {
          const v = r.Values?.[n];
          if (typeof v === 'number' && Number.isFinite(v)) {
            series.timestamps.push(t instanceof Date ? t.getTime() : Date.parse(String(t)));
            series.values.push(v);
          }
        });
      }
      token = result.NextToken;
    } while (token);
  }
  for (const series of out.values()) {
    const order = series.timestamps.map((t, n) => [t, series.values[n] as number] as const).sort((a, b) => a[0] - b[0]);
    series.timestamps = order.map(([t]) => t);
    series.values = order.map(([, v]) => v);
  }
  return out;
}

export const sumOf = (series: MetricSeries | undefined): number => (series?.values ?? []).reduce((a, b) => a + b, 0);
export const maxOf = (series: MetricSeries | undefined): number | undefined => (series && series.values.length > 0 ? Math.max(...series.values) : undefined);
export const lastOf = (series: MetricSeries | undefined): number | undefined => series?.values[series.values.length - 1];

export function createCloudWatch(cw: Sender, ttlMs = 30_000, now: () => Date = () => new Date()) {
  const rate = memo(() => busRate(cw, now()), ttlMs);
  const alarmState = memo(() => alarms(cw), ttlMs);
  const details = memo(() => alarmDetails(cw), ttlMs);
  return {
    busRate: () => rate.get(),
    alarms: () => alarmState.get(),
    alarmDetails: () => details.get(),
    metrics: (queries: MetricQuery[], start: Date, end: Date) => metricData(cw, queries, start, end),
  };
}
