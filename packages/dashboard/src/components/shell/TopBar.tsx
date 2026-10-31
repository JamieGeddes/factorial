'use client';

import { useLive, type StreamState } from '../../client/live.tsx';
import { useNow } from '../../client/now.tsx';
import { useStatus } from '../../client/status.tsx';
import { fmtTime } from '../../lib/format.ts';

const STATE_TEXT: Record<StreamState, string> = {
  connecting: 'Live feed connecting',
  connected: 'Live feed connected',
  reconnecting: 'Live feed reconnecting',
  down: 'Live feed down',
  idle: 'Live feed idle',
};

const STATE_DOT: Record<StreamState, string> = {
  connecting: 'dot warn',
  connected: 'dot pulse',
  reconnecting: 'dot warn',
  down: 'dot down',
  idle: 'dot idle',
};

/** The thin status bar: the stream's state, the bus rate, the alarm count and a clock. */
export function TopBar() {
  const live = useLive();
  const status = useStatus();
  const now = useNow();
  const alarms = status?.alarms;
  return (
    <header className="topbar">
      <span className="live" role="status" aria-live="polite">
        <span className={STATE_DOT[live.state]} />
        {STATE_TEXT[live.state]}
      </span>
      <span className="sep" />
      <span>
        factorial-work bus: <b className="num">{status?.busRate !== undefined ? status.busRate.toFixed(1) : '…'}</b> events/min
      </span>
      <span className="sep" />
      <span>
        Alarms:{' '}
        {alarms === undefined ? (
          <b>…</b>
        ) : alarms.total === 0 ? (
          <b>none set up, #16</b>
        ) : alarms.firing.length > 0 ? (
          <b className="alarm-firing" title={alarms.firing.join(', ')}>
            {alarms.firing.length} in alarm
          </b>
        ) : (
          <b>{`none firing (${alarms.total} set up)`}</b>
        )}
      </span>
      <span className="sep" />
      <span className="num">{live.received} live messages</span>
      <span className="clock num">{now ? fmtTime(new Date(now)) : '—'}</span>
    </header>
  );
}
