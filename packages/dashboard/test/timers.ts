import type { Timers } from '../src/server/live-connection.ts';

/** Timers the test moves by hand. */
export class ManualTimers implements Timers {
  private now = 0;
  private next = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  /** How many timers are waiting to fire. */
  get pending(): number {
    return this.timers.size;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    this.next += 1;
    this.timers.set(this.next, { at: this.now + ms, fn });
    return this.next;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Moves time on, running each timer due, in order, and letting promises settle between them. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      await settle();
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = end;
    await settle();
  }
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
