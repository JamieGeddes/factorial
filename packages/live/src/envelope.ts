/**
 * What the invoker publishes for each run event: the event with where it
 * belongs (`workItemId`, `attempt`, `role`, `stage`, `round`), its stream
 * number (`seq`) and when the invoker received it (`at`).
 *
 * The channel is a view, so its content is capped: the text of `text` and
 * `reasoning`, the input of `tool.call` (as JSON) and the content of
 * `tool.result` keep their first 16 KiB, and the envelope says it was cut
 * (`truncated`) and how large the field was (`bytes`). A `harness` event
 * carries its name only. Everything is redacted as the transcript is, before
 * it is cut, so a cut cannot split a credential past the redaction. The
 * catch-up chunks and the final transcript keep the uncut events.
 */
import { redactSecrets } from '@factorial/artefacts';

/** Each capped field keeps at most this many bytes. */
export const LIVE_FIELD_CAP_BYTES = 16 * 1024;
/**
 * The whole envelope's ceiling, under the service's 240 KB per delivered
 * message: an event whose uncapped fields (a run's `errors`, say) would pass
 * it is sent as its type alone.
 */
export const LIVE_ENVELOPE_MAX_BYTES = 64 * 1024;

export interface LiveEnvelope {
  workItemId: string;
  attempt?: number;
  role: string;
  stage: string;
  round: number;
  /** The event's number in the run's stream, from 1 without gaps. */
  seq: number;
  /** When the invoker received it. */
  at: string;
  /** The run event (contracts/run/v1/), capped. */
  event: Record<string, unknown>;
  /** Set when a field was cut or the event was left out. */
  truncated?: true;
  /** The cut field's size in bytes before it was cut. */
  bytes?: number;
}

export interface EnvelopeContext {
  workItemId: string;
  attempt?: number | undefined;
  role: string;
  stage: string;
  round: number;
}

/** The start of `text`, at most `maxBytes` of UTF-8, never splitting a character. */
export function cutToBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // A continuation byte at the cut means the character started before it.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

interface Cut {
  value: string;
  bytes: number;
  truncated: boolean;
}

function cap(text: string): Cut {
  const redacted = redactSecrets(text);
  const bytes = Buffer.byteLength(redacted);
  if (bytes <= LIVE_FIELD_CAP_BYTES) return { value: redacted, bytes, truncated: false };
  return { value: cutToBytes(redacted, LIVE_FIELD_CAP_BYTES), bytes, truncated: true };
}

/** The event as published: capped content, or the name alone for a harness event. */
function capped(event: Record<string, unknown>): { event: Record<string, unknown>; cut?: Cut } {
  switch (event.type) {
    case 'harness':
      return { event: { type: 'harness', ...(typeof event.name === 'string' ? { name: event.name } : {}) } };
    case 'text':
    case 'reasoning':
      if (typeof event.text !== 'string') return { event };
      return withField(event, 'text', cap(event.text));
    case 'tool.result':
      if (typeof event.content !== 'string') return { event };
      return withField(event, 'content', cap(event.content));
    case 'tool.call': {
      const input = JSON.stringify(event.input ?? {});
      const cut = cap(input);
      // Uncut, the input stays as the host sent it (the envelope is redacted whole); cut, it becomes the start of its JSON.
      return cut.truncated ? withField(event, 'input', cut) : { event };
    }
    default:
      return { event };
  }
}

function withField(event: Record<string, unknown>, field: string, cut: Cut): { event: Record<string, unknown>; cut: Cut } {
  return { event: { ...event, [field]: cut.value }, cut };
}

/** The envelope for one run event, serialised and redacted, ready to publish. */
export function liveEnvelope(context: EnvelopeContext, seq: number, at: Date, event: unknown): string {
  const source = typeof event === 'object' && event !== null && !Array.isArray(event) ? (event as Record<string, unknown>) : { type: 'unknown' };
  const { event: published, cut } = capped(source);
  const envelope: LiveEnvelope = {
    workItemId: context.workItemId,
    ...(context.attempt !== undefined ? { attempt: context.attempt } : {}),
    role: context.role,
    stage: context.stage,
    round: context.round,
    seq,
    at: at.toISOString(),
    event: published,
    ...(cut?.truncated ? { truncated: true as const, bytes: cut.bytes } : {}),
  };
  const text = redactSecrets(JSON.stringify(envelope));
  const size = Buffer.byteLength(text);
  if (size <= LIVE_ENVELOPE_MAX_BYTES) return text;
  const type = typeof source.type === 'string' ? source.type.slice(0, 64) : 'unknown';
  return JSON.stringify({ ...envelope, event: { type, omitted: true }, truncated: true, bytes: size });
}

/** Reads an envelope a subscriber received; undefined when it is not one. */
export function parseEnvelope(text: string): LiveEnvelope | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const envelope = value as Partial<LiveEnvelope> | null;
  if (typeof envelope !== 'object' || envelope === null) return undefined;
  if (!Number.isInteger(envelope.seq) || typeof envelope.event !== 'object' || envelope.event === null) return undefined;
  return envelope as LiveEnvelope;
}
