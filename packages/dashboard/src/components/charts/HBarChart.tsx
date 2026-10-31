'use client';

import { fmtDur } from '../../lib/format.ts';
import { niceMax } from '../../lib/charts.ts';
import { useTooltip } from './Tooltip.tsx';

export interface Bar {
  name: string;
  v: number;
  /** The 90th percentile, drawn as a marker. */
  p90?: number;
  color?: string;
  note?: string;
}

/** Horizontal bars with an optional p90 marker, a value label and a tooltip per row. */
export function HBarChart({ rows, fmt = fmtDur, color = 'var(--s1)', label }: { rows: Bar[]; fmt?: (v: number) => string; color?: string; label: string }) {
  const tip = useTooltip();
  const W = 520;
  const rowH = 22;
  const padL = 104;
  const padR = 54;
  const padT = 4;
  const H = padT + rows.length * rowH + 6;
  const max = niceMax(Math.max(0, ...rows.map((r) => r.p90 ?? r.v)) * 1.05);
  const span = W - padL - padR;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={label}>
      {rows.map((r, i) => {
        const y = padT + i * rowH;
        const w = (span * r.v) / max;
        return (
          <g key={r.name}>
            <text x={padL - 8} y={y + 14} textAnchor="end">
              {r.name}
            </text>
            <path d={`M${padL},${y + 3}h${Math.max(w - 4, 0)}a4,4 0 0 1 4,4v8a4,4 0 0 1 -4,4h${-Math.max(w - 4, 0)}z`} fill={r.color ?? color} />
            {r.p90 !== undefined ? <rect x={padL + (span * r.p90) / max - 1} y={y + 1} width={2} height={18} fill="var(--ink-2)" /> : null}
            <text x={padL + w + 8} y={y + 14} fill="var(--ink-2)">
              {fmt(r.v)}
            </text>
            <rect
              className="hit"
              x={0}
              y={y}
              width={W}
              height={rowH}
              onMouseEnter={(e) =>
                tip.show(
                  e,
                  <>
                    <b>{r.name}</b>
                    {r.p90 !== undefined ? (
                      <>
                        p50 <span className="num">{fmt(r.v)}</span> · p90 <span className="num">{fmt(r.p90)}</span>
                      </>
                    ) : (
                      <span className="num">{fmt(r.v)}</span>
                    )}
                    {r.note ? <div style={{ color: 'var(--ink-2)' }}>{r.note}</div> : null}
                  </>,
                )
              }
              onMouseMove={tip.move}
              onMouseLeave={tip.hide}
            />
          </g>
        );
      })}
    </svg>
  );
}
