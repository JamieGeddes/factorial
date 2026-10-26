/**
 * A run's transcript: every SDK message, one JSON line each, buffered to
 * local disk while the run goes on and uploaded when it ends. Lines are
 * redacted as they are written, so no credential the agent echoed reaches the
 * disk or the store. The host sends whole messages, never partial ones, so a
 * credential cannot be split across lines. Past the size cap, events are
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

export class TranscriptBuffer {
  readonly path: string;
  private readonly maxBytes: number;
  private readonly fd: number;
  private bytes = 0;
  private events = 0;
  private droppedEvents = 0;
  private truncated = false;
  private closed = false;

  constructor(path: string, maxBytes = MAX_TRANSCRIPT_BYTES) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.fd = openSync(path, 'w');
  }

  append(event: object, at: Date = new Date()): void {
    if (this.closed) return;
    this.write(event, at);
  }

  private write(event: object, at: Date): void {
    if (this.truncated) {
      this.droppedEvents += 1;
      return;
    }
    const line = `${redactSecrets(JSON.stringify({ at: at.toISOString(), ...event }))}\n`;
    const size = Buffer.byteLength(line);
    if (this.bytes + size > this.maxBytes - MARKER_RESERVE_BYTES) {
      this.truncated = true;
      this.droppedEvents += 1;
      return;
    }
    writeSync(this.fd, line);
    this.bytes += size;
    this.events += 1;
  }

  /** Stop writing, add the truncation marker if events were dropped, and say what was kept. */
  close(): TranscriptSummary {
    if (!this.closed) {
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
