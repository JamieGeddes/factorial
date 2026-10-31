/**
 * What the Metrics and Health views need from one run's `usage.json`
 * (`packages/invoker/src/run-record.ts`), kept small: a finished run's record
 * never changes, so these facts are kept for the life of the process.
 */

export interface ModelTokens {
  model: string;
  /** Input (cache reads and writes included) plus output. */
  tokens: number;
}

export interface UsageFacts {
  /** Tokens per model, subagents included: the harness's per-model totals, else the summed calls by model. */
  models: ModelTokens[];
  /** Each call that names its model and duration (#59): `[model, durationMs]`. */
  timed: [string, number][];
  /** Calls without a model or duration, recorded before #59. */
  untimed: number;
  /** `model.retry` events, recorded since #59. */
  retries?: number;
  /** The live feed's publishes and drops (#194). */
  live?: { published: number; dropped: number };
  /** Every model the version names, by id. */
  configured: string[];
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined);
const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** The facts of one `usage.json`, or undefined when it is not one. */
export function usageFacts(json: unknown): UsageFacts | undefined {
  const doc = record(json);
  if (!doc) return undefined;
  const harness = record(doc.harness) ?? record(doc.sdk);
  const calls = Array.isArray(doc.calls) ? doc.calls.map(record).filter((c): c is Record<string, unknown> => c !== undefined) : [];

  const fromHarness = new Map<string, number>();
  for (const entry of Array.isArray(harness?.models) ? harness.models : []) {
    const m = record(entry);
    const id = str(record(m?.model)?.id) ?? str(m?.id) ?? str(m?.modelId);
    const usage = record(m?.usage);
    if (!id || !usage) continue;
    fromHarness.set(id, (fromHarness.get(id) ?? 0) + num(usage.inputTokens) + num(usage.outputTokens));
  }
  const fromCalls = new Map<string, number>();
  const timed: [string, number][] = [];
  let untimed = 0;
  for (const call of calls) {
    const model = str(call.model);
    const ms = call.durationMs;
    if (model) fromCalls.set(model, (fromCalls.get(model) ?? 0) + num(call.inputTokens) + num(call.outputTokens));
    if (model && typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) timed.push([model, ms]);
    else untimed += 1;
  }
  const byModel = fromHarness.size > 0 ? fromHarness : fromCalls;
  const models = [...byModel].map(([model, tokens]) => ({ model, tokens }));

  const configured = new Set<string>();
  for (const entry of Array.isArray(harness?.configuredModels) ? harness.configuredModels : []) {
    const id = str(record(entry)?.id);
    if (id) configured.add(id);
  }
  const main = str(doc.modelId);
  if (main) configured.add(main);
  const explore = str(doc.exploreModelId);
  if (explore) configured.add(explore);

  const live = record(doc.live);
  return {
    models,
    timed,
    untimed,
    ...(typeof doc.retries === 'number' && Number.isFinite(doc.retries) ? { retries: num(doc.retries) } : {}),
    ...(live ? { live: { published: num(live.published), dropped: num(live.dropped) } } : {}),
    configured: [...configured],
  };
}

/** A model id as the charts name it: `Sonnet 5.5 global`, `Haiku 5.5 EU`. */
export function modelLabel(id: string): string {
  const m = /^(?:(global|eu|us|apac|jp|au)\.)?anthropic\.claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  if (!m) return id === 'compaction' ? 'Compaction' : id === 'unknown' ? 'Model not recorded' : id.length > 40 ? `${id.slice(0, 39)}…` : id;
  const family = (m[2] as string).charAt(0).toUpperCase() + (m[2] as string).slice(1);
  const where = m[1] ? ` ${m[1] === 'global' ? 'global' : m[1].toUpperCase()}` : '';
  return `${family} ${m[3]}.${m[4]}${where}`;
}
