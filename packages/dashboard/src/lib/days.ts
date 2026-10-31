/** Calendar days in the server's local time zone: the reviewer's own, since the app runs on their machine. */

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of an instant, in local time. */
export function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The last `n` days up to and including today, oldest first. */
export function lastDays(now: number, n: number): string[] {
  const today = new Date(now);
  return Array.from({ length: n }, (_, i) => dayOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (n - 1 - i), 12).getTime()));
}

/** A day's chart label: `31/10`. */
export function dayLabel(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(d)}/${Number(m)}`;
}
