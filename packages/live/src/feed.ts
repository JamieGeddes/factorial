/**
 * A run's events in order, from two sources that overlap: the catch-up
 * chunks (complete, but up to 30 seconds behind) and the live channel (from
 * the moment of subscribing). Each event is taken once, by `seq`, and handed
 * on only when every earlier one has been, so a reader prints the run from
 * its first event with no gap and no repeat.
 */
export class OrderedFeed<T> {
  private next = 1;
  private readonly waiting = new Map<number, T>();

  /** Offer one event; returns those now ready, in order. */
  offer(seq: number, item: T): T[] {
    if (Number.isInteger(seq) && seq >= this.next && !this.waiting.has(seq)) this.waiting.set(seq, item);
    const ready: T[] = [];
    for (let item = this.waiting.get(this.next); item !== undefined; item = this.waiting.get(this.next)) {
      this.waiting.delete(this.next);
      this.next += 1;
      ready.push(item);
    }
    return ready;
  }

  /** The next `seq` the feed needs. */
  get expected(): number {
    return this.next;
  }

  /** Whether later events are held back, waiting for one that has not arrived. */
  get gap(): boolean {
    return this.waiting.size > 0;
  }
}
