'use client';

import { useNow } from '../client/now.tsx';
import { fmtDur } from '../lib/format.ts';

/** A duration: fixed once `end` is known, ticking from `start` while it is not. */
export function Elapsed({ start, end }: { start: string | undefined; end?: string | undefined }) {
  const now = useNow();
  const from = start ? Date.parse(start) : NaN;
  if (!Number.isFinite(from)) return null;
  const to = end ? Date.parse(end) : now || from;
  return <>{fmtDur((to - from) / 1000)}</>;
}
