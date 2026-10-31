/**
 * The Health view (#59): every component the pipeline depends on with what it
 * reported last, the alarms, the quotas, the deploys and the webhook
 * deliveries, built on the server from what each source returned. A source
 * that could not be read says so on its own row; nothing is invented.
 */
import { dayOf } from './days.ts';
import { fmtDur, fmtK, fmtTime } from './format.ts';
import { commitUrl, type Repository } from './links.ts';
import type { LedgerRow } from './records.ts';
import { oneLine, text } from './sanitise.ts';
import { percentile, secondsBetween } from './stages.ts';
import { resultOf } from './status.ts';
import { modelLabel } from './usage-facts.ts';

export type Settled<T> = { value?: T; error?: string };

export type ComponentStatus = 'ok' | 'warn' | 'off';

export interface ComponentRow {
  name: string;
  detail: string;
  figure: string;
  status: ComponentStatus;
}

export interface QuotaMeter {
  name: string;
  used: number;
  limit: number;
  display: string;
}

export interface DeployRow {
  id: number;
  sha: string;
  shaUrl?: string;
  runUrl?: string;
  at: string;
  title: string;
  stacks: string;
  promoted: string;
  status: 'deployed' | 'skipped' | 'failed' | 'running' | 'cancelled';
  attempt: number;
}

export interface Health {
  generatedAt: string;
  components: ComponentRow[];
  alarms: { error?: string; list: { name: string; state: string; reason: string; at?: string }[] };
  quotas: { error?: string; meters: QuotaMeter[]; left: string[] };
  deploys: { error?: string; rows: DeployRow[] };
  webhooks: {
    error?: string;
    labels: string[];
    workItems: number[];
    ignored: number[];
    other: number[];
    totals: { delivered: number; workItems: number; closed: number; ignored: number; rejected: number; failed: number; unhandled: number };
    reasons: { reason: string; n: number }[];
    note?: string;
  };
}

export interface ModelQuota {
  model: string;
  tpm?: { peak: number; limit: number };
  rpm?: { peak: number; limit: number };
}

export interface HealthInput {
  now: number;
  rows: LedgerRow[];
  /** Live feed figures from the usage.json of runs that ended in the last 24 hours. */
  live: { published: number; dropped: number; runs: number };
  connection: string;
  adapter: Settled<{ invocations: number; errors: number }>;
  deliveries: Settled<{ hours: { at: number; outcome: string; n: number }[]; reasons: { reason: string; n: number }[] }>;
  bus: Settled<{ invocations: number; failed: number }>;
  busRate: Settled<number>;
  stateMachine: Settled<{ running: number; failedToday: number; liveVersion?: string }>;
  invoker: Settled<number>;
  runtimes: Settled<{ name: string; role: string; version?: string; status?: string }[]>;
  models: Settled<ModelQuota[]>;
  /** `model call retried` lines in the last 15 minutes, by the run's main model. */
  retries: Settled<{ model?: string; n: number }[]>;
  artefacts: Settled<{ bytes?: number; objects?: number }>;
  ledger: Settled<{ throttled: number }>;
  table: Settled<{ items?: number }>;
  alarms: Settled<{ name: string; state: string; reason?: string; updatedAt?: string }[]>;
  quotas: Settled<QuotaMeter[]>;
  deploys: Settled<{ id: number; attempt: number; sha: string; title: string; at: string; status: DeployRow['status']; stacks?: string[]; promoted?: { runtime: string; version: string }[] }[]>;
  repository: Repository;
}

const failed = (what: string, error: string): Pick<ComponentRow, 'detail' | 'figure' | 'status'> => ({ detail: `could not read ${what}`, figure: oneLine(error).slice(0, 80), status: 'warn' });
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

export function bytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

/** The invoker's start latency: Prepare's end to Build's start, over the last 30 items that built. */
export function startLatency(rows: LedgerRow[]): number | undefined {
  const gaps = rows
    .flatMap((r) => {
      const gap = secondsBetween(r.stages?.Prepare?.endedAt, r.stages?.Build?.startedAt);
      return gap !== undefined ? [{ at: r.stages?.Build?.startedAt ?? '', gap }] : [];
    })
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 30)
    .map((g) => g.gap);
  return percentile(gaps, 50);
}

/** A reason as the webhook panel groups it: quoted names and numbers folded, so one reason is one row. */
export function reasonKey(reason: string): string {
  return oneLine(text(reason))
    .replace(/"[^"]*"/g, '"…"')
    .replace(/#\d+/g, '#n')
    .slice(0, 120);
}

function components(input: HealthInput): ComponentRow[] {
  const { now, rows } = input;
  const out: ComponentRow[] = [];
  const startOfDay = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();

  const deliveries = input.deliveries.value ? input.deliveries.value.hours.reduce((a, h) => a + h.n, 0) : undefined;
  out.push({
    name: 'GitHub adapter factorial-github-issues-adapter',
    ...(input.adapter.value
      ? {
          detail: `live alias, ${plural(input.adapter.value.errors, 'error')} in 24 h`,
          figure: deliveries ? `${deliveries.toLocaleString('en-GB')} deliveries / 24h` : `${input.adapter.value.invocations.toLocaleString('en-GB')} invocations / 24h`,
          status: input.adapter.value.errors > 0 ? 'warn' : 'ok',
        }
      : failed('Lambda metrics', input.adapter.error ?? '')),
  });

  out.push({
    name: 'Event bus factorial-work',
    ...(input.bus.value
      ? {
          detail: `${plural(input.bus.value.failed, 'failed invocation')} of ${input.bus.value.invocations.toLocaleString('en-GB')} in 24 h`,
          figure: input.busRate.value !== undefined ? `${input.busRate.value.toFixed(1)} events/min` : 'rate unknown',
          status: input.bus.value.failed > 0 ? 'warn' : 'ok',
        }
      : failed('rule metrics', input.bus.error ?? '')),
  });

  out.push({
    name: 'State machine factorial-work',
    ...(input.stateMachine.value
      ? {
          detail: `${input.stateMachine.value.running} running, ${input.stateMachine.value.failedToday} failed today`,
          figure: input.stateMachine.value.liveVersion ? `alias live → v${input.stateMachine.value.liveVersion}` : 'alias live: unknown',
          status: input.stateMachine.value.failedToday > 0 ? 'warn' : 'ok',
        }
      : failed('Step Functions', input.stateMachine.error ?? '')),
  });

  const latency = startLatency(rows);
  out.push({
    name: 'Fargate invoker',
    ...(input.invoker.value !== undefined
      ? { detail: `${plural(input.invoker.value, 'task')} running`, figure: latency !== undefined ? `start latency p50 ${fmtDur(latency)}` : 'no start latency yet', status: 'ok' as const }
      : failed('ECS tasks', input.invoker.error ?? '')),
  });

  const sessions = (role: string) => rows.filter((r) => resultOf(r) === undefined && r.live && !r.live.ended && r.live.role === role).length;
  if (input.runtimes.value) {
    for (const rt of input.runtimes.value) {
      const n = sessions(rt.role);
      out.push({
        name: `Runtime ${oneLine(rt.name)}`,
        detail: rt.version ? `live → v${oneLine(rt.version)}, ${oneLine(rt.status ?? 'status unknown')}` : 'live endpoint not read',
        figure: plural(n, 'session'),
        status: !rt.version ? 'off' : rt.status === 'READY' ? 'ok' : 'warn',
      });
    }
  } else {
    out.push({ name: 'Runtimes', ...failed('the agent stack or the endpoints', input.runtimes.error ?? '') });
  }

  const retries = input.retries.value ?? [];
  const unattributed = retries.filter((r) => !r.model).reduce((a, r) => a + r.n, 0);
  if (input.models.value) {
    if (input.models.value.length === 0) out.push({ name: 'Bedrock', detail: 'no run in the last 7 days names a model', figure: '', status: 'off' });
    for (const m of input.models.value) {
      const n = retries.filter((r) => r.model === m.model).reduce((a, r) => a + r.n, 0);
      const tpm = m.tpm ? Math.round((m.tpm.peak / m.tpm.limit) * 100) : undefined;
      out.push({
        name: `Bedrock, ${modelLabel(m.model)} profile`,
        detail: input.retries.error ? 'retries unknown' : n > 0 ? `${plural(n, 'retry', 'retries')} in 15 min` : 'no retries in 15 min',
        figure: tpm !== undefined ? `TPM peak ${tpm}% of quota` : 'no quota found',
        status: n > 0 || (tpm ?? 0) > 85 ? 'warn' : 'ok',
      });
    }
    if (unattributed > 0) out.push({ name: 'Bedrock, other runs', detail: `${plural(unattributed, 'retry', 'retries')} in 15 min with no model on the line`, figure: '', status: 'warn' });
  } else {
    out.push({ name: 'Bedrock', ...failed('the models in use', input.models.error ?? '') });
  }

  const today = dayOf(now);
  const written = rows.reduce((a, r) => a + Object.values(r.stages ?? {}).filter((e) => typeof e?.startedAt === 'string' && Date.parse(e.startedAt) >= startOfDay && dayOf(Date.parse(e.startedAt)) === today).length, 0);
  out.push({
    name: 'Artefact store',
    ...(input.artefacts.value
      ? {
          detail: input.artefacts.value.bytes !== undefined ? `${bytes(input.artefacts.value.bytes)}${input.artefacts.value.objects !== undefined ? ` in ${input.artefacts.value.objects.toLocaleString('en-GB')} objects` : ''} (daily)` : 'no storage metric yet',
          figure: `${plural(written, 'stage')} wrote today`,
          status: 'ok' as const,
        }
      : failed('S3 storage metrics', input.artefacts.error ?? '')),
  });

  out.push({
    name: 'Ledger factorial-work-items',
    ...(input.ledger.value
      ? {
          detail: `${plural(input.ledger.value.throttled, 'throttled request')} in 24 h`,
          figure: input.table.value?.items !== undefined ? `${input.table.value.items.toLocaleString('en-GB')} rows` : `${rows.length.toLocaleString('en-GB')} rows scanned`,
          status: input.ledger.value.throttled > 0 ? 'warn' : 'ok',
        }
      : failed('DynamoDB metrics', input.ledger.error ?? '')),
  });

  out.push({
    name: 'Live feed factorial-live',
    detail: `stream ${input.connection}`,
    figure: input.live.runs ? `${fmtK(input.live.published)} published, ${fmtK(input.live.dropped)} dropped / 24h` : 'no run in 24 h',
    status: input.connection === 'down' || input.connection === 'reconnecting' || input.live.dropped > 0 ? 'warn' : 'ok',
  });

  out.push({ name: 'Traces (Transaction Search)', detail: 'not enabled in this account', figure: 'see #56', status: 'off' });
  return out;
}

const hourLabel = (ms: number) => fmtTime(new Date(ms)).slice(0, 2);

export function health(input: HealthInput): Health {
  const { now } = input;
  const hourNow = Math.floor(now / 3_600_000) * 3_600_000;
  const hours = Array.from({ length: 24 }, (_, i) => hourNow - (23 - i) * 3_600_000);
  const at = (ms: number) => hours.indexOf(Math.floor(ms / 3_600_000) * 3_600_000);
  const workItems = hours.map(() => 0);
  const ignored = hours.map(() => 0);
  const other = hours.map(() => 0);
  const totals = { delivered: 0, workItems: 0, closed: 0, ignored: 0, rejected: 0, failed: 0, unhandled: input.adapter.value?.errors ?? 0 };
  for (const h of input.deliveries.value?.hours ?? []) {
    const i = at(h.at);
    if (i < 0) continue;
    totals.delivered += h.n;
    if (h.outcome === 'work-item') {
      workItems[i] = (workItems[i] ?? 0) + h.n;
      totals.workItems += h.n;
    } else if (h.outcome === 'ignored') {
      ignored[i] = (ignored[i] ?? 0) + h.n;
      totals.ignored += h.n;
    } else {
      other[i] = (other[i] ?? 0) + h.n;
      if (h.outcome === 'closed') totals.closed += h.n;
      else if (h.outcome === 'rejected') totals.rejected += h.n;
      else totals.failed += h.n;
    }
  }
  const reasons = new Map<string, number>();
  for (const r of input.deliveries.value?.reasons ?? []) reasons.set(reasonKey(r.reason), (reasons.get(reasonKey(r.reason)) ?? 0) + r.n);
  const invocations = input.adapter.value?.invocations ?? 0;

  return {
    generatedAt: new Date(now).toISOString(),
    components: components(input),
    alarms: {
      ...(input.alarms.error ? { error: input.alarms.error } : {}),
      list: (input.alarms.value ?? []).map((a) => ({ name: oneLine(a.name), state: oneLine(a.state), reason: oneLine(text(a.reason)).slice(0, 240), ...(a.updatedAt ? { at: a.updatedAt } : {}) })),
    },
    quotas: {
      ...(input.quotas.error ? { error: input.quotas.error } : {}),
      meters: input.quotas.value ?? [],
      left: ['Bedrock requests per minute: no such quota for the models in use', 'Lambda, Step Functions and DynamoDB: on-demand, no usage metric against a quota'],
    },
    deploys: {
      ...(input.deploys.error ? { error: input.deploys.error } : {}),
      rows: (input.deploys.value ?? []).map((d) => {
        const shaUrl = commitUrl(input.repository, d.sha);
        return {
          id: d.id,
          sha: d.sha.slice(0, 7),
          ...(shaUrl ? { shaUrl } : {}),
          runUrl: `https://github.com/${input.repository.owner}/${input.repository.name}/actions/runs/${d.id}${d.attempt > 1 ? `/attempts/${d.attempt}` : ''}`,
          at: d.at,
          title: oneLine(text(d.title)).slice(0, 120),
          stacks: d.stacks === undefined ? (d.status === 'skipped' ? 'skipped' : '–') : d.stacks.length ? d.stacks.join(', ') : 'none changed',
          promoted: d.promoted === undefined ? '–' : d.promoted.length ? d.promoted.map((p) => `${p.runtime.replace(/^factorial_/, '')} v${p.version}`).join(', ') : 'none',
          status: d.status,
          attempt: d.attempt,
        };
      }),
    },
    webhooks: {
      ...(input.deliveries.error ? { error: input.deliveries.error } : {}),
      labels: hours.map(hourLabel),
      workItems,
      ignored,
      other,
      totals,
      reasons: [...reasons].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n).slice(0, 8),
      ...(!input.deliveries.error && totals.delivered === 0 && invocations > 0
        ? { note: `${plural(invocations, 'invocation')} in 24 h but no delivery lines: the adapter writes one per delivery from #59's deploy.` }
        : {}),
    },
  };
}
