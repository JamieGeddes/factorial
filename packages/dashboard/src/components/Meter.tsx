import { meterLevel, percentOf } from '../lib/meter.ts';

/** A bar against a limit: warning above 65%, critical above 85%. */
export function Meter({ value, max, label }: { value: number; max: number | undefined; label: string }) {
  const percent = percentOf(value, max);
  const level = meterLevel(percent);
  return (
    <div className={`meter${level === 'ok' ? '' : ` ${level}`}`} role="meter" aria-label={label} aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.min(percent, 100)}%` }} />
    </div>
  );
}

/** A labelled meter row: name, bar, value. */
export function MeterRow({ name, value, max, display }: { name: string; value: number; max: number | undefined; display: string }) {
  return (
    <div className="meter-row">
      <span>{name}</span>
      <Meter value={value} max={max} label={`${name}: ${display}`} />
      <span className="v">{display}</span>
    </div>
  );
}
