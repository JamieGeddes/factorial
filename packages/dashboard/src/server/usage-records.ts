import 'server-only';

import { usageFacts, type UsageFacts } from '../lib/usage-facts.ts';
import type { Artefacts } from './artefacts.ts';

/** A run entry's `usageKey`: `<workItemId>/<attempt>/<stage>/usage.json`, or `.../<stage>/round-<n>/usage.json` for a later round, nothing else. */
const USAGE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/\d{1,4}\/[a-z]+\/(?:round-\d{1,3}\/)?usage\.json$/;

export function isUsageKey(key: unknown): key is string {
  return typeof key === 'string' && USAGE_KEY.test(key) && !key.includes('..');
}

export interface UsageRecords {
  /** The facts of each key that exists, read at most `concurrency` at a time. */
  many(keys: string[]): Promise<Map<string, UsageFacts>>;
}

/**
 * Every run's `usage.json` as the Metrics and Health views need it (#59). A
 * record is written once, when its run ends, so its facts are kept for the
 * life of the process (at most `max` of them); one not written yet is read
 * again next time.
 */
export function createUsageRecords(artefacts: Pick<Artefacts, 'once'>, options: { concurrency?: number; max?: number } = {}): UsageRecords {
  const concurrency = options.concurrency ?? 24;
  const max = options.max ?? 50_000;
  const kept = new Map<string, UsageFacts>();
  const pending = new Map<string, Promise<UsageFacts | undefined>>();
  const read = (key: string): Promise<UsageFacts | undefined> => {
    const hit = kept.get(key);
    if (hit) return Promise.resolve(hit);
    let p = pending.get(key);
    if (!p) {
      p = artefacts
        .once(key)
        .then((body) => {
          if (body === undefined) return undefined;
          let json: unknown;
          try {
            json = JSON.parse(body);
          } catch {
            return undefined;
          }
          const facts = usageFacts(json);
          if (facts) {
            kept.set(key, facts);
            while (kept.size > max) kept.delete(kept.keys().next().value as string);
          }
          return facts;
        })
        .finally(() => pending.delete(key));
      pending.set(key, p);
    }
    return p;
  };
  return {
    async many(keys) {
      const unique = [...new Set(keys.filter(isUsageKey))];
      const out = new Map<string, UsageFacts>();
      let next = 0;
      const worker = async () => {
        while (next < unique.length) {
          const key = unique[next++] as string;
          try {
            const facts = await read(key);
            if (facts) out.set(key, facts);
          } catch {
            // A record that cannot be read is left out; the view says how many.
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
      return out;
    },
  };
}
