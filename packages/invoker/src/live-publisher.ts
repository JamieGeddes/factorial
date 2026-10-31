/**
 * Publishes a run's events to its live channel (#194), batched: up to five
 * events per request (the service's limit), sent when a batch is full or 250
 * ms after the first event waiting. One request is in flight at a time, so
 * events go out in order.
 *
 * The channel is a view, never part of the run: a failed or refused publish
 * is counted as dropped and reported at most once a minute, and nothing here
 * throws into the stream. With no endpoint (or the API deleted) every event is
 * dropped and the run goes on.
 */
import type { PublishBatch } from '@factorial/live';

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Reports a failure at most once per interval, with how many were suppressed since. */
export class ThrottledReport {
  private last = -Infinity;
  private suppressed = 0;
  private readonly report: (message: string, fields: Record<string, unknown>) => void;
  private readonly message: string;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(report: (message: string, fields: Record<string, unknown>) => void, message: string, intervalMs = 60_000, now: () => number = Date.now) {
    this.report = report;
    this.message = message;
    this.intervalMs = intervalMs;
    this.now = now;
  }

  failed(error: unknown, fields: Record<string, unknown> = {}): void {
    const now = this.now();
    if (now - this.last < this.intervalMs) {
      this.suppressed += 1;
      return;
    }
    this.last = now;
    const error_ = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    this.report(this.message, { error: error_, ...fields, ...(this.suppressed > 0 ? { suppressed: this.suppressed } : {}) });
    this.suppressed = 0;
  }
}

export interface PublisherOptions {
  channel: string;
  /** Undefined when there is no endpoint: every event is dropped. */
  send: PublishBatch | undefined;
  report: ThrottledReport;
  maxBatch?: number;
  flushMs?: number;
  /** Events waiting beyond this are dropped rather than held. */
  maxQueue?: number;
  timers?: Timers;
}

export class LivePublisher {
  published = 0;
  dropped = 0;
  private readonly queue: string[] = [];
  private readonly options: Required<Omit<PublisherOptions, 'send'>> & { send: PublishBatch | undefined };
  private timer: unknown;
  private draining: Promise<void> | undefined;
  private closed = false;
  /** Events sent and not yet answered. */
  private inFlight = 0;
  /** Set when close gave up waiting: a late answer then changes no count. */
  private settled = false;

  constructor(options: PublisherOptions) {
    this.options = { maxBatch: 5, flushMs: 250, maxQueue: 1000, timers: realTimers, ...options };
  }

  /** Queue one serialised envelope. Never throws. */
  add(event: string): void {
    if (this.closed || !this.options.send || this.queue.length >= this.options.maxQueue) {
      this.dropped += 1;
      return;
    }
    this.queue.push(event);
    this.kick(false);
  }

  private kick(force: boolean): void {
    if (this.draining) return;
    if (!force && this.queue.length < this.options.maxBatch) {
      if (this.timer === undefined && this.queue.length > 0) {
        this.timer = this.options.timers.set(() => {
          this.timer = undefined;
          this.kick(true);
        }, this.options.flushMs);
      }
      return;
    }
    this.clearTimer();
    this.draining = this.drain(force).finally(() => {
      this.draining = undefined;
      if (!this.closed && this.queue.length > 0) this.kick(false);
    });
  }

  private async drain(force: boolean): Promise<void> {
    while (this.queue.length >= this.options.maxBatch || (force && this.queue.length > 0)) {
      await this.send(this.queue.splice(0, this.options.maxBatch));
    }
  }

  private async send(batch: string[]): Promise<void> {
    this.inFlight = batch.length;
    try {
      const { failed } = await (this.options.send as PublishBatch)(this.options.channel, batch);
      if (this.settled) return;
      const refused = Math.min(Math.max(0, failed), batch.length);
      this.published += batch.length - refused;
      this.dropped += refused;
      if (refused > 0) this.options.report.failed(new Error(`${refused} of ${batch.length} events refused`), this.counts());
    } catch (error) {
      if (this.settled) return;
      this.dropped += batch.length;
      this.options.report.failed(error, this.counts());
    } finally {
      this.inFlight = 0;
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.options.timers.clear(this.timer);
    this.timer = undefined;
  }

  private counts(): { published: number; dropped: number } {
    return { published: this.published, dropped: this.dropped };
  }

  /** Send what is waiting, for at most `timeoutMs`; anything still unsent is dropped. */
  async close(timeoutMs: number): Promise<{ published: number; dropped: number }> {
    if (!this.closed) {
      this.closed = true;
      this.clearTimer();
      const flush = (async () => {
        if (this.draining) await this.draining;
        await this.drain(true);
      })();
      let timeout: unknown;
      await Promise.race([flush, new Promise<void>((resolve) => (timeout = this.options.timers.set(resolve, timeoutMs)))]);
      this.options.timers.clear(timeout);
      this.settled = true;
      this.dropped += this.queue.splice(0).length + this.inFlight;
      this.inFlight = 0;
    }
    return this.counts();
  }
}
