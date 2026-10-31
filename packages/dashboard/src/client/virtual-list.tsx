'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react';

/**
 * A scrolling list that renders only the rows in view (and `overscan` pixels
 * either side), so a run of tens of thousands of events stays responsive.
 * Rows may be any height: each is measured once rendered and the layout kept
 * in a prefix sum; a row not yet measured counts as `estimate`.
 *
 * With `follow`, the newest row is kept in view; scrolling away from the end
 * calls `onScrollAway`, which is how the reader turns following off.
 */
export function VirtualList({
  keys,
  render,
  follow,
  onScrollAway,
  header,
  estimate = 26,
  overscan = 800,
  className,
  label,
}: {
  keys: number[];
  render: (index: number) => ReactNode;
  follow: boolean;
  onScrollAway: () => void;
  header?: ReactNode;
  estimate?: number;
  overscan?: number;
  className?: string;
  label: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<number, number>());
  const [layout, setLayout] = useState(0);
  const [view, setView] = useState({ top: 0, height: 800 });
  const frame = useRef<number | undefined>(undefined);
  const observer = useRef<ResizeObserver | undefined>(undefined);

  const relayout = useCallback(() => {
    if (frame.current !== undefined) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      setLayout((n) => n + 1);
    });
  }, []);

  useEffect(() => {
    observer.current = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const key = Number(element.dataset.key);
        const height = entry.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight;
        if (Number.isFinite(key) && height > 0 && heights.current.get(key) !== height) {
          heights.current.set(key, height);
          changed = true;
        }
      }
      if (changed) relayout();
    });
    return () => {
      observer.current?.disconnect();
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
  }, [relayout]);

  // layout is read so a new measurement recomputes the offsets.
  const offsets = useMemo(() => {
    void layout;
    const out = new Float64Array(keys.length + 1);
    for (let i = 0; i < keys.length; i += 1) out[i + 1] = (out[i] as number) + (heights.current.get(keys[i] as number) ?? estimate);
    return out;
  }, [keys, layout, estimate]);
  const total = offsets[keys.length] as number;

  const offset = rows.current?.offsetTop ?? 0;
  const first = Math.max(0, search(offsets, view.top - offset - overscan) - 1);
  const last = Math.min(keys.length, search(offsets, view.top - offset + view.height + overscan) + 1);

  // Only the reader scrolling up turns following off: rows measured taller after a scroll to the end grow the list below without moving it.
  const lastTop = useRef(0);
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    setView({ top: el.scrollTop, height: el.clientHeight });
    if (follow && el.scrollTop < lastTop.current - 2 && el.scrollHeight - el.scrollTop - el.clientHeight > 24) onScrollAway();
    lastTop.current = el.scrollTop;
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (follow) {
      el.scrollTop = el.scrollHeight;
      lastTop.current = el.scrollTop;
    }
    setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight }));
  }, [follow, total, keys.length]);

  // Each row is observed while it is rendered (React 19 runs the returned cleanup when it goes).
  const measure = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const watching = observer.current;
    watching?.observe(element);
    return () => watching?.unobserve(element);
  }, []);

  const items: ReactNode[] = [];
  for (let i = first; i < last; i += 1) {
    const key = keys[i] as number;
    items.push(
      <div key={key} data-key={key} ref={measure} className="tr-row" style={{ top: offsets[i] }}>
        {render(i)}
      </div>,
    );
  }
  return (
    <div ref={scroller} className={className} onScroll={onScroll} role="log" aria-label={label} aria-live="off" tabIndex={0}>
      {header}
      <div ref={rows} className="tr-rows" style={{ height: total }}>
        {items}
      </div>
    </div>
  );
}

/** The index of the first offset at or above `y`. */
function search(offsets: Float64Array, y: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((offsets[mid] as number) < y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
