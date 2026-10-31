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

export function createCloudWatch(cw: Sender, ttlMs = 30_000, now: () => Date = () => new Date()) {
  const rate = memo(() => busRate(cw, now()), ttlMs);
  const alarmState = memo(() => alarms(cw), ttlMs);
  return { busRate: () => rate.get(), alarms: () => alarmState.get() };
}
