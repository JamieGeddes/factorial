'use client';

import { WORK_ITEMS_CHANNEL } from '@factorial/live/channels';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * The tab's one live stream (`/api/live`): every view that wants a channel
 * registers here, and the tab asks the server for the union, changing it
 * without reconnecting. The shell always wants `/factorial/work-items`.
 */
export type StreamState = 'connecting' | 'connected' | 'reconnecting' | 'down' | 'idle';

export interface ChannelState {
  events: number;
  chunks?: number;
  ended?: boolean;
  incomplete?: boolean;
}

export type LiveMessage =
  | { kind: 'hello'; stream: string }
  | { kind: 'event'; channel: string; envelope: { seq: number; at: string; event: Record<string, unknown>; [field: string]: unknown } }
  | { kind: 'progress'; channel: string; message: Record<string, unknown> }
  | { kind: 'state'; state: StreamState; channels: Record<string, ChannelState> };

type Listener = (message: LiveMessage) => void;

interface Live {
  state: StreamState;
  channels: Record<string, ChannelState>;
  /** Messages seen this session, for the status bar. */
  received: number;
  watch(channels: string[], listener: Listener): () => void;
}

const LiveContext = createContext<Live>({ state: 'idle', channels: {}, received: 0, watch: () => () => {} });

export function LiveProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StreamState>('connecting');
  const [channels, setChannels] = useState<Record<string, ChannelState>>({});
  const [received, setReceived] = useState(0);
  const watchers = useRef(new Map<number, { channels: string[]; listener: Listener }>());
  const stream = useRef<string | undefined>(undefined);
  const sent = useRef('');
  const nextId = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const wanted = () => [...new Set([WORK_ITEMS_CHANNEL, ...[...watchers.current.values()].flatMap((w) => w.channels)])].sort();

  const sync = () => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      const id = stream.current;
      const list = wanted();
      const key = list.join(',');
      if (!id || key === sent.current) return;
      sent.current = key;
      void fetch(`/api/live/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channels: list }) }).catch(() => {
        sent.current = '';
      });
    }, 50);
  };

  useEffect(() => {
    const source = new EventSource(`/api/live?channels=${encodeURIComponent(wanted().join(','))}`);
    let upstream: StreamState = 'connecting';
    source.onopen = () => setState(upstream);
    source.onerror = () => {
      stream.current = undefined;
      setState(source.readyState === EventSource.CLOSED ? 'down' : 'reconnecting');
    };
    source.onmessage = (event) => {
      let message: LiveMessage;
      try {
        message = JSON.parse(String(event.data)) as LiveMessage;
      } catch {
        return;
      }
      if (message.kind === 'hello') {
        stream.current = message.stream;
        sent.current = '';
        sync();
        return;
      }
      if (message.kind === 'state') {
        upstream = message.state;
        setState(message.state);
        setChannels(message.channels);
        return;
      }
      setReceived((n) => n + 1);
      for (const watcher of watchers.current.values()) if (watcher.channels.includes(message.channel)) watcher.listener(message);
    };
    return () => source.close();
    // The stream is opened once per tab; channel changes go through `sync`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<Live>(
    () => ({
      state,
      channels,
      received,
      watch(list, listener) {
        nextId.current += 1;
        const id = nextId.current;
        watchers.current.set(id, { channels: list, listener });
        sync();
        return () => {
          watchers.current.delete(id);
          sync();
        };
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, channels, received],
  );
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): Live {
  return useContext(LiveContext);
}

/** Calls `listener` for each message on `channels` while the component is mounted. */
export function useChannels(channels: string[], listener: Listener): void {
  const { watch } = useLive();
  const latest = useRef(listener);
  latest.current = listener;
  const key = channels.join(',');
  useEffect(() => watch(key ? key.split(',') : [], (message) => latest.current(message)), [watch, key]);
}
