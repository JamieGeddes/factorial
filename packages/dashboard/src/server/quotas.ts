import 'server-only';

import { GetServiceQuotaCommand, ListServiceQuotasCommand } from '@aws-sdk/client-service-quotas';

import type { Sender } from './aws.ts';

export interface Quota {
  service: string;
  code: string;
  name: string;
  value: number;
  /** The CloudWatch metric Service Quotas names for its usage, when it names one. */
  usage?: { namespace: string; metric: string; dimensions: Record<string, string>; stat: string };
}

type RawQuota = {
  ServiceCode?: string;
  QuotaCode?: string;
  QuotaName?: string;
  Value?: number;
  UsageMetric?: { MetricNamespace?: string; MetricName?: string; MetricDimensions?: Record<string, string>; MetricStatisticRecommendation?: string };
};

function quotaOf(q: RawQuota): Quota | undefined {
  if (!q.ServiceCode || !q.QuotaCode || !q.QuotaName || typeof q.Value !== 'number') return undefined;
  const u = q.UsageMetric;
  return {
    service: q.ServiceCode,
    code: q.QuotaCode,
    name: q.QuotaName,
    value: q.Value,
    ...(u?.MetricNamespace && u.MetricName ? { usage: { namespace: u.MetricNamespace, metric: u.MetricName, dimensions: u.MetricDimensions ?? {}, stat: u.MetricStatisticRecommendation ?? 'Maximum' } } : {}),
  };
}

/** Every quota of a service whose name matches `pattern`. */
export async function quotasMatching(sq: Sender, service: string, pattern: RegExp): Promise<Quota[]> {
  const out: Quota[] = [];
  let token: string | undefined;
  do {
    const page = (await sq.send(new ListServiceQuotasCommand({ ServiceCode: service, MaxResults: 100, ...(token ? { NextToken: token } : {}) }))) as { Quotas?: RawQuota[]; NextToken?: string };
    for (const raw of page.Quotas ?? []) {
      const q = quotaOf(raw);
      if (q && pattern.test(q.name)) out.push(q);
    }
    token = page.NextToken;
  } while (token);
  return out;
}

/** One quota by its code, or undefined when the account does not have it. */
export async function quota(sq: Sender, service: string, code: string): Promise<Quota | undefined> {
  try {
    const result = (await sq.send(new GetServiceQuotaCommand({ ServiceCode: service, QuotaCode: code }))) as { Quota?: RawQuota };
    return result.Quota ? quotaOf(result.Quota) : undefined;
  } catch (error) {
    if ((error as { name?: string }).name === 'NoSuchResourceException') return undefined;
    throw error;
  }
}
