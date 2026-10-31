/** Timers a test advances by hand, for the live feed's batching and intervals. */
import type { Timers } from './live-publisher.ts';

export class ManualTimers implements Timers {
  now = 0;
  private nextId = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  set(callback: () => void, ms: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.pending.set(id, { at: this.now + ms, callback });
    return id;
  }

  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  /** Move time on, firing every timer due, in order. */
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.pending].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = until;
  }

  get size(): number {
    return this.pending.size;
  }
}

/** Let queued promise callbacks run. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
