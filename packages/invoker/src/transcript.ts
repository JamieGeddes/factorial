/**
 * The build transcript: every harness stream event, one JSON line each,
 * buffered to local disk while the build runs and uploaded when it ends.
 * Lines are redacted as they are written, so no credential the agent echoed
 * reaches the disk or the store. Text and tool input stream in small deltas
 * that can split a credential, so consecutive deltas of one kind are joined
 * into a single line before they are redacted. Past the size cap, events are
 * counted but not kept, and a truncation marker becomes the last line.
 */
import { closeSync, openSync, writeSync } from 'node:fs';

import { redactSecrets } from '@factorial/artefacts';

export const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;
/** Room kept below the cap for the truncation marker. */
const MARKER_RESERVE_BYTES = 1024;

export interface TranscriptSummary {
  bytes: number;
  events: number;
  droppedEvents: number;
  truncated: boolean;
}

type DeltaKind = 'text' | 'toolUse';

interface PendingDelta {
  kind: DeltaKind;
  at: Date;
  contentBlockIndex: unknown;
  parts: string[];
  length: number;
  events: number;
}

/** The streamed text in a delta event, and which kind it is; undefined for any other event. */
function deltaOf(event: object): { kind: DeltaKind; text: string; contentBlockIndex: unknown } | undefined {
  const block = (event as { contentBlockDelta?: { contentBlockIndex?: unknown; delta?: { text?: unknown; toolUse?: { input?: unknown } } } })
    .contentBlockDelta;
  if (typeof block?.delta?.text === 'string') return { kind: 'text', text: block.delta.text, contentBlockIndex: block.contentBlockIndex };
  if (typeof block?.delta?.toolUse?.input === 'string') {
    return { kind: 'toolUse', text: block.delta.toolUse.input, contentBlockIndex: block.contentBlockIndex };
  }
  return undefined;
}

export class TranscriptBuffer {
  readonly path: string;
  private readonly maxBytes: number;
  private readonly fd: number;
  private bytes = 0;
  private events = 0;
  private droppedEvents = 0;
  private truncated = false;
  private closed = false;
  private pending: PendingDelta | undefined;

  constructor(path: string, maxBytes = MAX_TRANSCRIPT_BYTES) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.fd = openSync(path, 'w');
  }

  append(event: object, at: Date = new Date()): void {
    if (this.closed) return;
    const delta = deltaOf(event);
    if (delta && this.pending?.kind === delta.kind && this.pending.contentBlockIndex === delta.contentBlockIndex) {
      this.pending.parts.push(delta.text);
      this.pending.length += delta.text.length;
      this.pending.events += 1;
      if (this.pending.length >= this.maxBytes) this.flush();
      return;
    }
    this.flush();
    if (delta) {
      this.pending = { ...delta, at, parts: [delta.text], length: delta.text.length, events: 1 };
      return;
    }
    this.write(event, at, 1);
  }

  /** Write the joined deltas as one event, so a credential split across them is redacted whole. */
  private flush(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    const text = pending.parts.join('');
    const delta = pending.kind === 'text' ? { text } : { toolUse: { input: text } };
    this.write(
      { contentBlockDelta: { ...(pending.contentBlockIndex === undefined ? {} : { contentBlockIndex: pending.contentBlockIndex }), delta } },
      pending.at,
      pending.events,
    );
  }

  private write(event: object, at: Date, events: number): void {
    if (this.truncated) {
      this.droppedEvents += events;
      return;
    }
    const line = `${redactSecrets(JSON.stringify({ at: at.toISOString(), ...event }))}\n`;
    const size = Buffer.byteLength(line);
    if (this.bytes + size > this.maxBytes - MARKER_RESERVE_BYTES) {
      this.truncated = true;
      this.droppedEvents += events;
      return;
    }
    writeSync(this.fd, line);
    this.bytes += size;
    this.events += events;
  }

  /** Stop writing, add the truncation marker if events were dropped, and say what was kept. */
  close(): TranscriptSummary {
    if (!this.closed) {
      this.flush();
      this.closed = true;
      if (this.truncated) {
        const marker = `${JSON.stringify({
          truncated: true,
          keptEvents: this.events,
          droppedEvents: this.droppedEvents,
          maxBytes: this.maxBytes,
        })}\n`;
        writeSync(this.fd, marker);
        this.bytes += Buffer.byteLength(marker);
      }
      closeSync(this.fd);
    }
    return { bytes: this.bytes, events: this.events, droppedEvents: this.droppedEvents, truncated: this.truncated };
  }
}
