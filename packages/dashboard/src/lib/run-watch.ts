/**
 * What the Overview takes from each running session's channel: its last
 * event, the main loop's model calls so far (its turns, until the live record
 * has them) and its model call retries, for the Attention list.
 */
import { fmtTime, shortId } from './format.ts';
import type { Notice } from './overview.ts';
import { describeShort, type RunEvent } from './transcript.ts';

export interface RunWatch {
  /** The last `seq` taken: a channel replayed to a remounted view is not counted twice. */
  seq: number;
  turns: number;
  last?: { text: string; at: string };
  retries: { at: string; status?: number }[];
}

export function emptyWatch(): RunWatch {
  return { seq: 0, turns: 0, retries: [] };
}

export function watchEvent(state: RunWatch, entry: RunEvent): RunWatch {
  if (entry.seq <= state.seq) return state;
  const event = entry.event;
  const next: RunWatch = { ...state, seq: entry.seq, last: { text: describeShort(event), at: entry.at } };
  if (event.type === 'model.call' && typeof event.agentId !== 'string') next.turns = state.turns + 1;
  if (event.type === 'model.retry') next.retries = [...state.retries, { at: entry.at, ...(typeof event.status === 'number' ? { status: event.status } : {}) }].slice(-200);
  return next;
}

/** How long without a retry before the model calls count as recovered. */
export const RETRY_CLEAR_MS = 5 * 60_000;
const HOUR = 3_600_000;

/** One notice per session that retried model calls in the last hour: retrying while the last retry is recent, cleared once it is not. */
export function retryNotices(watches: Record<string, RunWatch>, now: number): Notice[] {
  const out: Notice[] = [];
  for (const [channel, watch] of Object.entries(watches)) {
    const recent = watch.retries.filter((r) => now - Date.parse(r.at) <= HOUR);
    const last = recent.at(-1);
    if (!last) continue;
    const id = shortId(channel.split('/')[3] ?? '');
    const lastAt = Date.parse(last.at);
    const count = `${recent.length} ${recent.length === 1 ? 'retry' : 'retries'} in the last hour`;
    const status = last.status !== undefined ? ` (HTTP ${last.status})` : '';
    const href = `/runs/${channel.split('/').slice(3).join('/')}`;
    if (now - lastAt < RETRY_CLEAR_MS) out.push({ tone: 'warn', text: `Model calls retrying for ${id}${status}: ${count}`, at: last.at, href });
    else out.push({ tone: 'ok', text: `Model call retries stopped for ${id}: ${count}, none since ${fmtTime(new Date(lastAt)).slice(0, 5)}`, at: new Date(lastAt + RETRY_CLEAR_MS).toISOString(), href });
  }
  return out;
}
