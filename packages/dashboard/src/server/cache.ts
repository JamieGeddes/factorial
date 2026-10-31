import 'server-only';

/**
 * In-memory caches only: nothing is written to disk. A value is read once
 * per `ttlMs` however many requests want it, and a read in flight is shared.
 */
export function memo<T>(load: () => Promise<T>, ttlMs: number, now: () => number = Date.now): { get(): Promise<T>; clear(): void } {
  let value: { at: number; promise: Promise<T> } | undefined;
  return {
    get() {
      if (value && now() - value.at < ttlMs) return value.promise;
      const promise = load();
      const entry = { at: now(), promise };
      value = entry;
      // A failed read is not kept: the next caller tries again.
      promise.catch(() => {
        if (value === entry) value = undefined;
      });
      return promise;
    },
    clear() {
      value = undefined;
    },
  };
}

/** `memo` per key, with at most `max` keys kept (the oldest dropped first). */
export function memoByKey<T>(load: (key: string) => Promise<T>, ttlMs: number, max = 1000, now: () => number = Date.now): (key: string) => Promise<T> {
  const entries = new Map<string, { at: number; promise: Promise<T> }>();
  return (key) => {
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.promise;
    const promise = load(key);
    const entry = { at: now(), promise };
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > max) entries.delete(entries.keys().next().value as string);
    promise.catch(() => {
      if (entries.get(key) === entry) entries.delete(key);
    });
    return promise;
  };
}

/** Bytes kept for the life of the process, up to `maxBytes` in all (least recently used dropped first). */
export class ByteCache {
  private readonly entries = new Map<string, { bytes: Uint8Array; contentType: string }>();
  private size = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  get(key: string): { bytes: Uint8Array; contentType: string } | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, bytes: Uint8Array, contentType: string): void {
    if (bytes.byteLength > this.maxBytes / 4) return;
    const old = this.entries.get(key);
    if (old) {
      this.size -= old.bytes.byteLength;
      this.entries.delete(key);
    }
    this.entries.set(key, { bytes, contentType });
    this.size += bytes.byteLength;
    for (const [k, v] of this.entries) {
      if (this.size <= this.maxBytes) break;
      this.entries.delete(k);
      this.size -= v.bytes.byteLength;
    }
  }
}
