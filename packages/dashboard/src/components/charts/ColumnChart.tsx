'use client';

import { fmtK } from '../../lib/format.ts';
import { niceMax, roundTop } from '../../lib/charts.ts';
import { Legend } from './Legend.tsx';
import { TipLine, useTooltip } from './Tooltip.tsx';

export interface Series {
  name: string;
  color: string;
  values: number[];
}

/** Stacked columns, one per label, with a tooltip per column and a legend when there is more than one series. */
export function ColumnChart({ series, labels, height = 170, fmt = fmtK, unit = '', label }: { series: Series[]; labels: string[]; height?: number; fmt?: (v: number) => string; unit?: string; label: string }) {
  const tip = useTooltip();
  const W = 520;
  const H = height;
  const padL = 36;
  const padR = 8;
  const padT = 10;
  const padB = 22;
  const n = Math.max(labels.length, 1);
  const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals) * 1.05 || 1);
  const ticks = [4, 5, 2].find((t) => Number.isInteger(max / t) || max / t >= 1000) ?? 4;
  const slot = (W - padL - padR) / n;
  const bw = Math.min(24, slot * 0.6);
  const plot = H - padT - padB;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={label}>
        <g className="grid">
          {Array.from({ length: ticks + 1 }, (_, t) => {
            const y = padT + plot * (1 - t / ticks);
            return (
              <g key={t}>
                <line x1={padL} x2={W - padR} y1={y} y2={y} />
                <text x={padL - 6} y={y + 4} textAnchor="end">
                  {fmt((max * t) / ticks)}
                </text>
              </g>
            );
          })}
        </g>
        {labels.map((lab, i) => {
          let y0 = H - padB;
          const x = padL + slot * i + (slot - bw) / 2;
          const bars = series.map((s, si) => {
            const v = s.values[i] ?? 0;
            if (!v) return null;
            const h = (plot * v) / max;
            const top = y0 - h;
            const last = series.slice(si + 1).every((ss) => !ss.values[i]);
            const d = last ? roundTop(x, top, bw, Math.max(h - (si ? 2 : 0), 0), 4) : `M${x},${top}h${bw}v${Math.max(h - 2, 0)}h${-bw}z`;
            y0 = top;
            return <path key={s.name} d={d} fill={s.color} />;
          });
          return (
            <g key={lab}>
              {bars}
              <rect
                className="hit"
                x={padL + slot * i}
                y={padT}
                width={slot}
                height={plot}
                onMouseEnter={(e) =>
                  tip.show(
                    e,
                    <>
                      <b>{lab}</b>
                      {series.map((s) => (
                        <TipLine key={s.name} color={s.color} name={s.name} value={`${fmt(s.values[i] ?? 0)}${unit}`} />
                      ))}
                      {series.length > 1 ? <div style={{ marginTop: 3, color: 'var(--ink-2)' }}>Total <span className="num">{`${fmt(totals[i] ?? 0)}${unit}`}</span></div> : null}
                    </>,
                  )
                }
                onMouseMove={tip.move}
                onMouseLeave={tip.hide}
              />
              {n <= 16 || i % 2 === 0 ? (
                <text x={padL + slot * i + slot / 2} y={H - 6} textAnchor="middle">
                  {lab}
                </text>
              ) : null}
            </g>
          );
        })}
        <line className="axis" x1={padL} x2={W - padR} y1={H - padB} y2={H - padB} />
      </svg>
      <Legend series={series} />
    </div>
  );
}
