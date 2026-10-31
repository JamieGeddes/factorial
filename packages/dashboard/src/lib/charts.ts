/** Chart geometry shared by the SVG chart components, ported from the mockup. */

/** A round axis maximum at or above `v`: 1, 2, 2.5, 5 or 10 times a power of ten. */
export function niceMax(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return m * p;
}

/** A column's path with its top corners rounded. */
export function roundTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, h / 2, w / 2));
  return `M${x},${y + h}v${-(h - rr)}a${rr},${rr} 0 0 1 ${rr},${-rr}h${w - 2 * rr}a${rr},${rr} 0 0 1 ${rr},${rr}v${h - rr}z`;
}

/** A sparkline's line path over a 72 by 28 box, and where its last point is. */
export function sparkPath(values: number[], width = 72, height = 28): { line: string; last: { x: number; y: number } } | undefined {
  if (values.length < 2) return undefined;
  const mx = Math.max(...values);
  const mn = Math.min(...values);
  const xs = (i: number) => 2 + ((width - 4) * i) / (values.length - 1);
  const ys = (v: number) => 2 + (height - 4) * (1 - (v - mn) / (mx - mn || 1));
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join('');
  const lastIndex = values.length - 1;
  return { line, last: { x: xs(lastIndex), y: ys(values[lastIndex] as number) } };
}
