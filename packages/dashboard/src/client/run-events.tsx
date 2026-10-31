'use client';

import { useEffect, useRef, useState } from 'react';

import { addToTally, emptyTally, fromEnvelope, fromTranscriptLine, type RunEvent, type Tally } from '../lib/transcript.ts';
import { useChannels } from './live.tsx';

export type RunSource = 'channel' | 'transcript';

export interface RunEvents {
  /** Every event kept, in `seq` order; read the first `count`. */
  events: RunEvent[];
  /** How many are shown: frozen while paused, while the rest still arrive. */
  count: number;
  /** How many have arrived. */
  received: number;
  tally: Tally;
  source: RunSource;
  /** The stored transcript is being read: bytes so far and in all. */
  loading?: { read: number; total?: number };
  /** The stored transcript said it was cut at its size cap. */
  marker?: { keptEvents?: number; droppedEvents?: number };
  error?: string;
  /** When the view first had events: anything newer arrived while the reader watched. */
  since: number;
}

/**
 * A run's events, from the stored `transcript.jsonl` once the run has ended,
 * or from its live channel (which the server replays from `seq` 1) while it
 * goes on or when there is no transcript. The transcript is read as a stream
 * and parsed in slices, so a 10 MB file never holds the page.
 */
export function useRunEvents(channel: string, transcript: string | undefined, paused: boolean, onEvent?: (entry: RunEvent) => void): RunEvents {
  const [source, setSource] = useState<RunSource>(transcript ? 'transcript' : 'channel');
  const events = useRef<RunEvent[]>([]);
  const tally = useRef<Tally>(emptyTally());
  const [received, setReceived] = useState(0);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState<RunEvents['loading']>(transcript ? { read: 0 } : undefined);
  const [marker, setMarker] = useState<RunEvents['marker']>();
  const [error, setError] = useState<string | undefined>();
  const since = useRef(Date.now());
  const frame = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(onEvent);
  latest.current = onEvent;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const flush = () => {
    if (frame.current !== undefined) return;
    // A timer, not an animation frame: a tab in the background still takes its events.
    frame.current = setTimeout(() => {
      frame.current = undefined;
      setReceived(events.current.length);
      if (!pausedRef.current) setCount(events.current.length);
    }, 50);
  };

  const take = (entry: RunEvent) => {
    const last = events.current.at(-1);
    if (last && entry.seq <= last.seq) return;
    events.current.push(entry);
    addToTally(tally.current, entry);
    latest.current?.(entry);
  };

  useEffect(() => {
    if (!paused) setCount(events.current.length);
  }, [paused]);

  useEffect(() => () => {
    if (frame.current !== undefined) clearTimeout(frame.current);
  }, []);

  useEffect(() => {
    if (source !== 'transcript' || !transcript) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetch(transcript, { cache: 'no-store', signal: abort.signal });
        if (response.status === 404) {
          setLoading(undefined);
          setSource('channel');
          return;
        }
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const total = Number(response.headers.get('content-length')) || undefined;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let rest = '';
        let read = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          read += value.byteLength;
          rest += decoder.decode(value, { stream: true });
          const lines = rest.split('\n');
          rest = lines.pop() ?? '';
          for (let i = 0; i < lines.length; i += 1) {
            const parsed = fromTranscriptLine(lines[i] as string);
            if (parsed && 'marker' in parsed) setMarker(parsed.marker as RunEvents['marker']);
            else if (parsed) take(parsed);
            // Yield to the page every few thousand lines.
            if (i % 2000 === 1999) await new Promise((resolve) => setTimeout(resolve, 0));
          }
          setLoading({ read, ...(total ? { total } : {}) });
          flush();
        }
        const parsed = fromTranscriptLine(rest + decoder.decode());
        if (parsed && 'marker' in parsed) setMarker(parsed.marker as RunEvents['marker']);
        else if (parsed) take(parsed);
        setLoading(undefined);
        flush();
      } catch (e) {
        if (abort.signal.aborted) return;
        setLoading(undefined);
        setError(`The stored transcript could not be read (${e instanceof Error ? e.message : String(e)}); reading the channel instead.`);
        setSource('channel');
      }
    })();
    return () => abort.abort();
    // The source is chosen once per run; `take` and `flush` only touch refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, transcript]);

  useChannels(source === 'channel' ? [channel] : [], (message) => {
    if (message.kind !== 'event' || message.channel !== channel) return;
    const entry = fromEnvelope(message.envelope);
    if (!entry) return;
    take(entry);
    flush();
  });

  return {
    events: events.current,
    count,
    received,
    tally: tally.current,
    source,
    ...(loading ? { loading } : {}),
    ...(marker ? { marker } : {}),
    ...(error ? { error } : {}),
    since: since.current,
  };
}
