'use client';

import { WORK_ITEMS_CHANNEL } from '@factorial/live/channels';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useChannels, type LiveMessage } from './live.tsx';

/**
 * A view's data, read again from its route when work-item progress arrives
 * (at most once a second, and only progress `wants` names) and every
 * `everyMs` regardless.
 */
export function useRefreshed<T>(url: string, initial: T, options: { everyMs?: number; wants?: (message: Record<string, unknown>) => boolean } = {}): { data: T; error?: string; reload: () => void } {
  const [data, setData] = useState<T>(initial);
  const [error, setError] = useState<string | undefined>();
  const current = useRef(url);
  current.current = url;
  const wants = useRef(options.wants);
  wants.current = options.wants;

  useEffect(() => setData(initial), [initial]);

  const load = useCallback(async () => {
    const asked = current.current;
    try {
      const response = await fetch(asked, { cache: 'no-store' });
      const body = (await response.json()) as T & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      if (current.current === asked) {
        setData(body);
        setError(undefined);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reload = useCallback(() => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = undefined;
      void load();
    }, 1000);
  }, [load]);

  useChannels([WORK_ITEMS_CHANNEL], (message: LiveMessage) => {
    if (message.kind !== 'progress') return;
    if (wants.current && !wants.current(message.message)) return;
    reload();
  });

  // A new URL (a filter changed) is read at once, not at the next tick.
  const shown = useRef(url);
  useEffect(() => {
    if (shown.current === url) return;
    shown.current = url;
    void load();
  }, [url, load]);

  const every = options.everyMs ?? 20_000;
  useEffect(() => {
    const timer = setInterval(() => void load(), every);
    return () => {
      clearInterval(timer);
      if (pending.current) clearTimeout(pending.current);
      pending.current = undefined;
    };
  }, [load, every]);

  return { data, ...(error ? { error } : {}), reload };
}
