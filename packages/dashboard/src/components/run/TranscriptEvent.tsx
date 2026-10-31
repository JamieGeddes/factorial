import { fmtTime } from '../../lib/format.ts';
import { kindOf, type Line, type RunEvent } from '../../lib/transcript.ts';

/** The most of a tool's input or result shown expanded; the stored transcript holds the rest. */
export const EXPANDED_MAX_CHARS = 256 * 1024;

const time = (at: string) => {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? fmtTime(new Date(ms)) : '';
};

/**
 * One event as the mockup renders it: its `seq`, its time, a kind label and
 * its text. Every string is the run's and reaches the page as React text,
 * never as markup.
 */
export function TranscriptEvent({ entry, line, open, onToggle, fresh }: { entry: RunEvent; line: Line; open: boolean; onToggle: (open: boolean) => void; fresh?: boolean }) {
  const event = entry.event;
  const kind = kindOf(event);
  const classes = ['ev', kind, event.isError === true ? 'err' : '', typeof event.agentId === 'string' ? 'in-agent' : '', fresh ? 'new' : ''].filter(Boolean).join(' ');
  const body = line.more?.body ?? '';
  const shown = body.length > EXPANDED_MAX_CHARS ? body.slice(0, EXPANDED_MAX_CHARS) : body;
  return (
    <div className={classes}>
      <span className="seq num">{entry.seq}</span>
      <span className="at">{time(entry.at)}</span>
      <div className="c">
        <span className="kind">{line.kind}</span>
        {line.more ? (
          <details open={open} onToggle={(e) => onToggle((e.currentTarget as HTMLDetailsElement).open)}>
            <summary>
              {line.more.summary}
              <span className="more">{line.more.label}</span>
            </summary>
            {open ? (
              <pre tabIndex={0}>
                {shown}
                {shown.length < body.length ? `\n… the first ${EXPANDED_MAX_CHARS / 1024} KiB of ${Math.round(body.length / 1024)} KiB; the stored transcript holds it all.` : ''}
              </pre>
            ) : null}
          </details>
        ) : (
          line.text
        )}
        {line.note ? <span className="cut">{line.note}</span> : null}
      </div>
    </div>
  );
}
