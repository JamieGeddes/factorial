import { sparkPath } from '../../lib/charts.ts';

export function Sparkline({ values, color = 'var(--ink-3)', accent = 'var(--accent)' }: { values: number[]; color?: string; accent?: string }) {
  const path = sparkPath(values);
  if (!path) return null;
  return (
    <svg viewBox="0 0 72 28" aria-hidden="true">
      <path d={`${path.line}V28H2z`} fill={accent} opacity=".12" />
      <path d={path.line} fill="none" stroke={color} strokeWidth="1.5" />
      <circle cx={path.last.x} cy={path.last.y} r="2.5" fill={accent} />
    </svg>
  );
}
