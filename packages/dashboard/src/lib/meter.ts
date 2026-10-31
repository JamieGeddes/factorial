/** A meter's level: warning above 65%, critical above 85%, as the mockup draws them. */
export type MeterLevel = 'ok' | 'warn' | 'crit';

export const METER_WARN_ABOVE = 65;
export const METER_CRIT_ABOVE = 85;

export function meterLevel(percent: number): MeterLevel {
  if (percent > METER_CRIT_ABOVE) return 'crit';
  if (percent > METER_WARN_ABOVE) return 'warn';
  return 'ok';
}

/** The share of `max` that `value` is, in percent; 0 when there is no limit. */
export function percentOf(value: number, max: number | undefined): number {
  if (!max || max <= 0 || !Number.isFinite(value)) return 0;
  return (value / max) * 100;
}
