'use client';

import { useDeferredValue, useMemo, useRef, useState } from 'react';

import { useLive } from '../../client/live.tsx';
import type { RunEvents } from '../../client/run-events.tsx';
import { VirtualList } from '../../client/virtual-list.tsx';
import { describe, fmtBytes, passes, searchText, TRANSCRIPT_FILTER_LABELS, TRANSCRIPT_FILTERS, type Line, type RunEvent, type TranscriptFilter } from '../../lib/transcript.ts';
import { FilterChips } from '../FilterChips.tsx';
import { TranscriptEvent } from './TranscriptEvent.tsx';

/** Lines are described once per event and kept: a search over thousands reads the cache. */
const lines = new WeakMap<RunEvent, { line: Line; search?: string }>();

function lineOf(entry: RunEvent, agents: Map<string, string>): { line: Line; search?: string } {
  let cached = lines.get(entry);
  if (!cached) {
    cached = { line: describe(entry, agents) };
    lines.set(entry, cached);
  }
  return cached;
}

/**
 * The transcript: filters, a search within the run, Follow (the newest event
 * kept in view, off once the reader scrolls up), Jump to latest, Pause (the
 * view stops updating while events are still kept), and a footer with the
 * channel, its state, the event count and the catch-up chunks read.
 */
export function Transcript({ run, channel, paused, onPause }: { run: RunEvents; channel: string; paused: boolean; onPause: (paused: boolean) => void }) {
  const live = useLive();
  const [filter, setFilter] = useState<TranscriptFilter>('all');
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const [follow, setFollow] = useState(true);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const agents = useRef(new Map<string, string>());

  const { events, count } = run;
  const shown = useMemo(() => {
    const out: RunEvent[] = [];
    for (let i = 0; i < count; i += 1) {
      const entry = events[i] as RunEvent;
      const event = entry.event;
      if (event.type === 'subagent.started' && typeof event.agentId === 'string' && typeof event.agentType === 'string') agents.current.set(event.agentId, event.agentType);
      if (!passes(event, filter)) continue;
      if (deferred) {
        const cached = lineOf(entry, agents.current);
        cached.search ??= searchText(cached.line);
        if (!cached.search.includes(deferred)) continue;
      }
      out.push(entry);
    }
    return out;
  }, [events, count, filter, deferred]);
  const keys = useMemo(() => shown.map((e) => e.seq), [shown]);

  const state = live.channels[channel];
  const connection =
    run.source === 'transcript'
      ? run.loading
        ? `reading transcript.jsonl: ${fmtBytes(run.loading.read)}${run.loading.total ? ` of ${fmtBytes(run.loading.total)}` : ''}`
        : 'transcript.jsonl (run ended)'
      : `${channel} ${state?.ended ? 'ended' : state?.incomplete ? 'ended without its last event' : live.state}`;
  const chunks = run.source === 'channel' ? (state?.chunks ?? 0) : undefined;

  const toggle = (seq: number) => (isOpen: boolean) =>
    setOpen((prev) => {
      if (prev.has(seq) === isOpen) return prev;
      const next = new Set(prev);
      if (isOpen) next.add(seq);
      else next.delete(seq);
      return next;
    });

  const header = (
    <>
      {chunks ? <div className="chunk-note">{`Caught up from ${chunks} stored chunk${chunks === 1 ? '' : 's'}, then the channel. Events are deduplicated by sequence number.`}</div> : null}
      {run.marker ? <div className="chunk-note">{`The stored transcript reached its size cap: ${run.marker.keptEvents ?? '?'} events kept, ${run.marker.droppedEvents ?? '?'} left out.`}</div> : null}
      {run.error ? <div className="chunk-note">{run.error}</div> : null}
      {count === 0 && !run.loading ? <div className="empty">{run.source === 'channel' ? 'No events yet: waiting for the run on its channel.' : 'The transcript holds no events.'}</div> : null}
      {count > 0 && shown.length === 0 ? <div className="empty">No events match. Clear the filter or the search to see more.</div> : null}
    </>
  );

  return (
    <div className="card flush transcript">
      <div className="tr-bar">
        <FilterChips label="Filter the transcript" options={TRANSCRIPT_FILTERS.map((f) => ({ value: f, label: TRANSCRIPT_FILTER_LABELS[f] }))} value={filter} onChange={setFilter} />
        <input className="search" type="search" placeholder="Find in transcript" aria-label="Find in transcript" style={{ minWidth: 160 }} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="status">
          <button type="button" className="btn" aria-pressed={follow} onClick={() => setFollow(!follow)}>
            Follow
          </button>
          <button type="button" className="btn" aria-pressed={paused} onClick={() => onPause(!paused)}>
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </div>
      <VirtualList
        className="tr-body"
        label="Transcript"
        keys={keys}
        follow={follow}
        onScrollAway={() => setFollow(false)}
        header={header}
        render={(i) => {
          const entry = shown[i] as RunEvent;
          const at = Date.parse(entry.at);
          return <TranscriptEvent entry={entry} line={lineOf(entry, agents.current).line} open={open.has(entry.seq)} onToggle={toggle(entry.seq)} fresh={Number.isFinite(at) && at > run.since && Date.now() - at < 5000} />;
        }}
      />
      <div className="tr-foot">
        <span>{connection}</span>
        <span>{`${run.received} events${paused && run.received > count ? ` (${run.received - count} held while paused)` : ''}`}</span>
        {chunks !== undefined ? <span>{`catch-up: ${chunks} chunk${chunks === 1 ? '' : 's'}`}</span> : null}
        <button type="button" className="btn jump" onClick={() => setFollow(true)}>
          Jump to latest
        </button>
      </div>
    </div>
  );
}
