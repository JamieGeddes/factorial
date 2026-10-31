/**
 * A run's events (`contracts/run/v1/`) as the Run & transcript view shows
 * them (#58), from either source: an envelope on the live channel (capped at
 * 16 KiB a field, marked `truncated` with the field's full size) or a line of
 * the stored `transcript.jsonl` (uncut). Every field is the model's, a
 * tool's or the harness's, so all of it is untrusted: it is sanitised here
 * and rendered as text.
 */
import { fmtDur, fmtK, fmtUsd } from './format.ts';
import { sanitise } from './sanitise.ts';

export interface RunEvent {
  seq: number;
  at: string;
  event: Record<string, unknown>;
  /** The live feed cut a field of this event, or left the event out. */
  truncated?: boolean;
  /** The cut field's full size in bytes. */
  bytes?: number;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? sanitise(value) : '');
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** An envelope from the channel, as the stream sends it. */
export function fromEnvelope(envelope: { seq?: unknown; at?: unknown; event?: unknown; truncated?: unknown; bytes?: unknown }): RunEvent | undefined {
  if (!Number.isInteger(envelope.seq) || !isObject(envelope.event)) return undefined;
  return {
    seq: envelope.seq as number,
    at: typeof envelope.at === 'string' ? envelope.at : '',
    event: envelope.event,
    ...(envelope.truncated === true ? { truncated: true } : {}),
    ...(num(envelope.bytes) !== undefined ? { bytes: envelope.bytes as number } : {}),
  };
}

/** A line of `transcript.jsonl`: the event with `at` and `seq`. Lines without a `seq` (the request, the truncation marker) are not events. */
export function fromTranscriptLine(line: string): RunEvent | { marker: Record<string, unknown> } | undefined {
  if (!line.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObject(value)) return undefined;
  const { at, seq, ...event } = value;
  if (!Number.isInteger(seq)) return value.truncated === true ? { marker: value } : undefined;
  return { seq: seq as number, at: typeof at === 'string' ? at : '', event };
}

export type EventKind = 'sys' | 'text' | 'reasoning' | 'tool' | 'result' | 'model' | 'warn' | 'sub';

const KINDS: Record<string, EventKind> = {
  'run.started': 'sys',
  'run.ended': 'sys',
  text: 'text',
  reasoning: 'reasoning',
  'tool.call': 'tool',
  'tool.result': 'result',
  'model.call': 'model',
  'model.retry': 'warn',
  'subagent.started': 'sub',
  'subagent.ended': 'sub',
  'context.compacted': 'warn',
};

export function kindOf(event: Record<string, unknown>): EventKind {
  return KINDS[String(event.type)] ?? 'sys';
}

export const TRANSCRIPT_FILTERS = ['all', 'text', 'tool', 'model', 'sub'] as const;
export type TranscriptFilter = (typeof TRANSCRIPT_FILTERS)[number];
export const TRANSCRIPT_FILTER_LABELS: Record<TranscriptFilter, string> = { all: 'All', text: 'Model text', tool: 'Tools', model: 'Model calls', sub: 'Subagents' };

export function passes(event: Record<string, unknown>, filter: TranscriptFilter): boolean {
  const type = String(event.type);
  switch (filter) {
    case 'all':
      return true;
    case 'text':
      return type === 'text' || type === 'reasoning';
    case 'tool':
      return type === 'tool.call' || type === 'tool.result';
    case 'model':
      return type === 'model.call' || type === 'model.retry' || type === 'context.compacted';
    case 'sub':
      return type.startsWith('subagent.') || typeof event.agentId === 'string';
  }
}

/** The fields that say what a tool call is about come first: a write's path before its content. */
const LEADING = ['path', 'file_path', 'command', 'pattern', 'query', 'url', 'description'];
const leading = (key: string) => {
  const i = LEADING.indexOf(key);
  return i === -1 ? LEADING.length : i;
};

/** A tool's input as lines of `key: value`, as the mockup shows it; a cut input is the start of its JSON. */
export function formatInput(input: unknown): string {
  if (typeof input === 'string') {
    try {
      return formatInput(JSON.parse(input));
    } catch {
      return sanitise(input);
    }
  }
  if (isObject(input)) return sanitise(Object.entries(input).sort(([a], [b]) => leading(a) - leading(b)).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n'));
  return sanitise(JSON.stringify(input ?? null) ?? '');
}

/** The first line of `text`, at most `max` characters, and whether anything was left out. */
export function firstLine(text: string, max = 110): { line: string; more: boolean } {
  const end = text.indexOf('\n');
  const first = end === -1 ? text : text.slice(0, end);
  return { line: first.length > max ? `${first.slice(0, max - 1)}…` : first, more: end !== -1 || first.length > max };
}

/** A UTF-8 byte count, without a Buffer in the browser. */
export function byteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** A size: `512 B`, `16.0 KB`, `2.40 MB`. */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** The short form the Overview's sessions table shows as the last event. */
export function describeShort(event: Record<string, unknown>): string {
  const type = str(event.type) || 'event';
  switch (type) {
    case 'tool.call': {
      const input = isObject(event.input) ? event.input : {};
      const target = [input.path, input.file_path, input.command, input.pattern, input.query, input.url].find((v) => typeof v === 'string');
      return `${str(event.tool)} ${str(target).replace(/\s+/g, ' ').slice(0, 28)}`.trim();
    }
    case 'tool.result':
      return event.isError === true ? 'tool result (error)' : 'tool result';
    case 'text':
      return 'assistant text';
    case 'model.call': {
      const usage = isObject(event.usage) ? event.usage : {};
      return `model call ${fmtK(num(usage.inputTokens) ?? 0)} in`;
    }
    case 'model.retry':
      return 'model call retried';
    case 'subagent.started':
      return `subagent ${str(event.agentType)} started`;
    case 'subagent.ended':
      return `subagent ${str(event.agentType)} ended`;
    case 'context.compacted':
      return 'context compacted';
    default:
      return type;
  }
}

export interface Tally {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  modelCalls: number;
  toolCalls: number;
  /** The main loop's model calls: the turns, until `run.ended` gives the figure. */
  turns: number;
  costUsd?: number;
  /** The largest input of one model call. */
  peakContext: number;
  retries: number;
  startedAt?: string;
  ended?: { outcome: string; reason: string; durationMs?: number; turns?: number; costUsd?: number };
  models?: { purpose: string; id: string }[];
  harness?: { name: string; version?: string };
}

export function emptyTally(): Tally {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, modelCalls: 0, toolCalls: 0, turns: 0, peakContext: 0, retries: 0 };
}

/** Adds one event to a tally. Mid-run the figures are the sum of the calls; `run.ended`'s totals replace them, as the contract says to trust them. */
export function addToTally(tally: Tally, entry: RunEvent): Tally {
  const event = entry.event;
  switch (event.type) {
    case 'run.started': {
      tally.startedAt = entry.at;
      const harness = isObject(event.harness) ? event.harness : undefined;
      if (harness && typeof harness.name === 'string') tally.harness = { name: str(harness.name), ...(typeof harness.version === 'string' ? { version: str(harness.version) } : {}) };
      if (Array.isArray(event.models)) tally.models = event.models.filter(isObject).map((m) => ({ purpose: str(m.purpose), id: str(m.id) }));
      break;
    }
    case 'model.call': {
      const usage = isObject(event.usage) ? event.usage : {};
      const input = num(usage.inputTokens) ?? 0;
      tally.inputTokens += input;
      tally.outputTokens += num(usage.outputTokens) ?? 0;
      tally.cacheReadInputTokens += num(usage.cacheReadInputTokens) ?? 0;
      tally.cacheWriteInputTokens += num(usage.cacheWriteInputTokens) ?? 0;
      tally.modelCalls += 1;
      if (typeof event.agentId !== 'string') tally.turns += 1;
      tally.peakContext = Math.max(tally.peakContext, input);
      const cost = isObject(event.cost) ? num(event.cost.usd) : undefined;
      if (cost !== undefined) tally.costUsd = (tally.costUsd ?? 0) + cost;
      break;
    }
    case 'model.retry':
      tally.retries += 1;
      break;
    case 'tool.call':
      tally.toolCalls += 1;
      break;
    case 'run.ended': {
      const cost = isObject(event.cost) ? num(event.cost.usd) : undefined;
      tally.ended = {
        outcome: str(event.outcome),
        reason: str(event.reason),
        ...(num(event.durationMs) !== undefined ? { durationMs: event.durationMs as number } : {}),
        ...(num(event.turns) !== undefined ? { turns: event.turns as number } : {}),
        ...(cost !== undefined ? { costUsd: cost } : {}),
      };
      if (num(event.turns) !== undefined) tally.turns = event.turns as number;
      if (cost !== undefined) tally.costUsd = cost;
      if (Array.isArray(event.models) && event.models.length > 0) {
        const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
        for (const m of event.models.filter(isObject)) {
          const usage = isObject(m.usage) ? m.usage : {};
          for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += num(usage[k]) ?? 0;
        }
        Object.assign(tally, totals);
      }
      break;
    }
  }
  return tally;
}

export function tallyOf(events: RunEvent[]): Tally {
  return events.reduce(addToTally, emptyTally());
}

/** Whether an event is the builder writing its plan: a write tool call to `plan.json`. */
export function isPlanWrite(event: Record<string, unknown>): boolean {
  if (event.type !== 'tool.call' || typeof event.tool !== 'string' || event.tool.toLowerCase() !== 'write') return false;
  const input = event.input;
  const path = isObject(input) ? (input.path ?? input.file_path) : typeof input === 'string' ? /"(?:path|file_path)"\s*:\s*"([^"]*)"/.exec(input)?.[1] : undefined;
  return typeof path === 'string' && /(^|\/)plan\.json$/.test(path);
}

export interface PlanStep {
  id: string;
  description?: string;
  files: string[];
}

/** The steps of a plan (`contracts/plan/v1/`), sanitised; undefined when it is not one. */
export function planSteps(value: unknown): PlanStep[] | undefined {
  if (!isObject(value) || !Array.isArray(value.steps)) return undefined;
  return value.steps.filter(isObject).slice(0, 100).map((step) => ({
    id: str(step.id).slice(0, 40) || '(no id)',
    ...(typeof step.description === 'string' ? { description: str(step.description).slice(0, 2000) } : {}),
    files: Array.isArray(step.files) ? step.files.filter((f): f is string => typeof f === 'string').slice(0, 50).map((f) => str(f).slice(0, 500)) : [],
  }));
}

/** The plan a write tool call carries, when its input holds all of it. */
export function planFromWrite(event: Record<string, unknown>): PlanStep[] | undefined {
  if (!isPlanWrite(event) || !isObject(event.input) || typeof event.input.content !== 'string') return undefined;
  try {
    return planSteps(JSON.parse(event.input.content));
  } catch {
    return undefined;
  }
}

export interface Line {
  /** The label in the coloured box. */
  kind: string;
  /** The text after it, on its own when nothing expands. */
  text: string;
  /** What expands under it: a tool's whole input or result. */
  more?: { summary: string; body: string; label: string };
  /** A note after the text: the feed cut it, with its full size. */
  note?: string;
}

const agentPrefix = (event: Record<string, unknown>, agents: Map<string, string>) =>
  typeof event.agentId === 'string' ? `${agents.get(event.agentId) ?? 'subagent'} · ` : '';

/** What the transcript shows for one event, as text: everything is rendered by React, never as markup. */
export function describe(entry: RunEvent, agents: Map<string, string> = new Map()): Line {
  const event = entry.event;
  const type = str(event.type) || 'event';
  const cut = entry.truncated && entry.bytes !== undefined ? `truncated, ${fmtBytes(entry.bytes)} in full` : entry.truncated ? 'truncated' : undefined;
  if (event.omitted === true) return { kind: type, text: 'left out of the live feed: too large for one message', ...(cut ? { note: cut } : {}) };
  switch (type) {
    case 'run.started': {
      const harness = isObject(event.harness) ? `${str(event.harness.name)} ${str(event.harness.version)}`.trim() : '';
      const models = Array.isArray(event.models) ? event.models.filter(isObject).map((m) => `${str(m.purpose)} ${str(m.id)}`).join(' · ') : '';
      const tools = Array.isArray(event.tools) ? event.tools.filter((t) => typeof t === 'string').map(str).join(', ') : '';
      return { kind: 'run started', text: [harness, models].filter(Boolean).join(' · ') + (tools ? `\ntools: ${tools}` : '') };
    }
    case 'run.ended': {
      const cost = isObject(event.cost) ? num(event.cost.usd) : undefined;
      const parts = [
        `outcome ${str(event.outcome)} (${str(event.reason)})`,
        num(event.turns) !== undefined ? `${event.turns as number} turns` : '',
        num(event.durationMs) !== undefined ? fmtDur((event.durationMs as number) / 1000) : '',
        cost !== undefined ? fmtUsd(cost) : '',
        num(event.deniedToolCalls) !== undefined ? `${event.deniedToolCalls as number} denied tool calls` : '',
      ].filter(Boolean);
      const errors = Array.isArray(event.errors) ? event.errors.filter((e) => typeof e === 'string').map(str).join('\n') : '';
      return { kind: 'run ended', text: parts.join(' · ') + (errors ? `\n${errors}` : '') };
    }
    case 'text':
    case 'reasoning':
      return { kind: `${agentPrefix(event, agents)}${type}`, text: str(event.text).trimEnd(), ...(cut ? { note: cut } : {}) };
    case 'tool.call': {
      const input = formatInput(event.input);
      const { line, more } = firstLine(input);
      return { kind: `${agentPrefix(event, agents)}${str(event.tool) || 'tool'}`, text: line, ...(more || cut ? { more: { summary: line, body: input, label: 'input' } } : {}), ...(cut ? { note: cut } : {}) };
    }
    case 'tool.result': {
      const content = str(event.content);
      const { line, more } = firstLine(content || '(empty)');
      const size = entry.bytes ?? byteLength(content);
      return { kind: `${agentPrefix(event, agents)}${event.isError === true ? 'error' : 'result'}`, text: line, ...(more || cut ? { more: { summary: line, body: content, label: fmtBytes(size) } } : {}), ...(cut ? { note: cut } : {}) };
    }
    case 'model.call': {
      const usage = isObject(event.usage) ? event.usage : {};
      const model = isObject(event.model) ? str(event.model.id) : '';
      const parts = [
        model,
        `in ${fmtK(num(usage.inputTokens) ?? 0)}`,
        `cache read ${fmtK(num(usage.cacheReadInputTokens) ?? 0)}`,
        `cache write ${fmtK(num(usage.cacheWriteInputTokens) ?? 0)}`,
        `out ${fmtK(num(usage.outputTokens) ?? 0)}${event.exact === false ? '+' : ''}`,
        num(event.durationMs) !== undefined ? `latency ${((event.durationMs as number) / 1000).toFixed(1)}s` : '',
      ].filter(Boolean);
      return { kind: `${agentPrefix(event, agents)}model call`, text: parts.join('   ') };
    }
    case 'model.retry': {
      const max = num(event.maxRetries);
      const parts = [
        event.status === null || event.status === undefined ? 'no status' : `HTTP ${str(String(event.status))}`,
        num(event.delayMs) !== undefined ? `wait ${event.delayMs as number} ms` : '',
        str(event.error),
      ].filter(Boolean);
      return { kind: `retry ${num(event.attempt) ?? '?'}${max !== undefined ? `/${max}` : ''}`, text: parts.join(' · ') };
    }
    case 'subagent.started':
      return { kind: 'subagent started', text: `${str(event.agentType)} (${str(event.agentId).slice(-12)}): its events are marked as its own` };
    case 'subagent.ended': {
      const parts = [
        `${str(event.agentType)} (${str(event.agentId).slice(-12)})`,
        num(event.durationMs) !== undefined ? fmtDur((event.durationMs as number) / 1000) : '',
        num(event.toolCalls) !== undefined ? `${event.toolCalls as number} tool calls` : '',
        num(event.finalContextTokens) !== undefined ? `final context ${fmtK(event.finalContextTokens as number)}` : '',
      ].filter(Boolean);
      return { kind: 'subagent ended', text: parts.join(' · ') };
    }
    case 'context.compacted':
      return { kind: 'compacted', text: `${str(event.trigger)} · ${fmtK(num(event.tokensBefore) ?? 0)} → ${fmtK(num(event.tokensAfter) ?? 0)} tokens` };
    case 'harness':
      return { kind: 'harness', text: str(event.name) };
    default:
      return { kind: type, text: '' };
  }
}

/** Everything a search looks through for an event, lower-cased. */
export function searchText(line: Line): string {
  return `${line.kind}\n${line.text}\n${line.more?.body ?? ''}`.toLowerCase();
}
