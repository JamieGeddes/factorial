import { runLine } from '../lib/run-line.ts';
import type { StageEntry } from '../lib/records.ts';

/** Under a stage's name: the runtime, its turns and tool calls, and why it stopped. */
export function RunLine({ entry }: { entry: StageEntry }) {
  const line = runLine(entry);
  if (!line) return null;
  return (
    <span className="sub run-line">
      {line.lead}
      {line.lead && line.stopped ? ' · ' : ''}
      {line.stopped ? <span className={`stop ${line.tone}`}>{line.stopped}</span> : null}
    </span>
  );
}
