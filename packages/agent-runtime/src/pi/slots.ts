/**
 * At most `size` holders at a time; the rest wait, first come first served.
 * pi runs the tool calls in one response at once, so the subagent tool takes a
 * slot for each child session it runs (harness.ts); a nested call takes one
 * only when one is free (`tryTake`), else its parent's place.
 */
export class Slots {
  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(size: number) {
    this.free = size;
  }

  /** Takes a free slot without waiting, returning what frees it, or undefined when none is free. */
  tryTake(): (() => void) | undefined {
    if (this.free === 0) return undefined;
    this.free -= 1;
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      this.release();
    };
  }

  /** Runs `work` once a slot is free, and frees it however `work` ends. */
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free -= 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  /** Hands a slot to the first waiter, or back to the free ones. */
  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.free += 1;
  }
}
