/** Number, money, duration and time formats, as the mockup shows them. */

export function fmtK(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
  return String(Math.round(n));
}

export function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** `42s`, `3m 07s`, `1h 05m`. */
export function fmtDur(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `HH:MM:SS` in local time. */
export function fmtTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The first eight characters of a work item id, as every view shows it. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Text cut to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** When something happened, as the deploys table says it: `today 18:02`, `yesterday 21:40`, `3 days ago`. */
export function fmtWhen(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const day = (ms: number) => new Date(new Date(ms).setHours(0, 0, 0, 0)).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  const time = fmtTime(new Date(at)).slice(0, 5);
  if (days <= 0) return `today ${time}`;
  if (days === 1) return `yesterday ${time}`;
  return `${days} days ago`;
}
