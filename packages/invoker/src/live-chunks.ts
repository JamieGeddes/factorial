/**
 * Uploads a run's catch-up chunks (#194, @factorial/live chunks.ts): the
 * transcript lines since the last upload, every 200 events or 30 seconds,
 * whichever comes first, and what is left when the run ends. Uploads go one at
 * a time, in order, and each chunk number is used once, so a key is written
 * once whether its upload succeeds or not. A failed upload is counted and
 * reported, never raised: the final transcript stays the record. The lines are
 * the ones the transcript kept, so its size cap covers the chunks too.
 */
import { CHUNK_EVENTS, CHUNK_SECONDS } from '@factorial/live';

import { realTimers, type ThrottledReport, type Timers } from './live-publisher.ts';

export interface ChunkOptions {
  /** Stores chunk `n`'s text. */
  put: (n: number, text: string) => Promise<void>;
  report: ThrottledReport;
  maxEvents?: number;
  maxAgeMs?: number;
  timers?: Timers;
}

export interface ChunkSummary {
  count: number;
  lastSeq?: number;
  failed: number;
}

export class LiveChunks {
  private readonly options: Required<ChunkOptions>;
  private pending: string[] = [];
  private pendingLastSeq = 0;
  private next = 1;
  private uploaded = 0;
  private failed = 0;
  private lastSeq: number | undefined;
  private chain: Promise<void> = Promise.resolve();
  private timer: unknown;
  private closed = false;

  constructor(options: ChunkOptions) {
    this.options = { maxEvents: CHUNK_EVENTS, maxAgeMs: CHUNK_SECONDS * 1000, timers: realTimers, ...options };
  }

  /** Take one transcript line (ending in a newline) and its seq. Never throws. */
  add(line: string, seq: number): void {
    if (this.closed) return;
    this.pending.push(line);
    this.pendingLastSeq = seq;
    if (this.pending.length >= this.options.maxEvents) this.flush();
    else if (this.timer === undefined) {
      this.timer = this.options.timers.set(() => {
        this.timer = undefined;
        this.flush();
      }, this.options.maxAgeMs);
    }
  }

  private flush(): void {
    if (this.timer !== undefined) this.options.timers.clear(this.timer);
    this.timer = undefined;
    if (this.pending.length === 0) return;
    const n = this.next;
    this.next += 1;
    const text = this.pending.join('');
    const lastSeq = this.pendingLastSeq;
    this.pending = [];
    this.chain = this.chain.then(async () => {
      try {
        await this.options.put(n, text);
        this.uploaded += 1;
        this.lastSeq = lastSeq;
      } catch (error) {
        this.failed += 1;
        this.options.report.failed(error, { chunk: n });
      }
    });
  }

  /** Upload what is left and wait for every upload. */
  async close(): Promise<ChunkSummary> {
    if (!this.closed) {
      this.flush();
      this.closed = true;
    }
    await this.chain;
    return this.summary();
  }

  summary(): ChunkSummary {
    return { count: this.uploaded, ...(this.lastSeq !== undefined ? { lastSeq: this.lastSeq } : {}), failed: this.failed };
  }
}
