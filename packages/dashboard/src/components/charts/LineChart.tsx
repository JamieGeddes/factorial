'use client';

import { niceMax } from '../../lib/charts.ts';
import type { Series } from './ColumnChart.tsx';
import { Legend } from './Legend.tsx';
import { TipLine, useTooltip } from './Tooltip.tsx';

/** Lines over shared labels, each ending in a labelled point, with a tooltip per label. */
export function LineChart({ series, labels, height = 170, fmt = (v: number) => v.toFixed(1), min = 0, max, label }: { series: Series[]; labels: string[]; height?: number; fmt?: (v: number) => string; min?: number; max?: number; label: string }) {
  const tip = useTooltip();
  const W = 520;
  const H = height;
  const padL = 32;
  const padR = 70;
  const padT = 10;
  const padB = 22;
  const all = series.flatMap((s) => s.values);
  const mx = max ?? niceMax(Math.max(0, ...all) * 1.05);
  const n = labels.length;
  const step = n > 1 ? (W - padL - padR) / (n - 1) : W - padL - padR;
  const xs = (i: number) => padL + step * i;
  const ys = (v: number) => padT + (H - padT - padB) * (1 - (v - min) / (mx - min || 1));
  const ticks = 4;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={label}>
        <g className="grid">
          {Array.from({ length: ticks + 1 }, (_, t) => {
            const y = padT + (H - padT - padB) * (1 - t / ticks);
            return (
              <g key={t}>
                <line x1={padL} x2={W - padR} y1={y} y2={y} />
                <text x={padL - 6} y={y + 4} textAnchor="end">
                  {fmt(min + ((mx - min) * t) / ticks)}
                </text>
              </g>
            );
          })}
        </g>
        {series.map((s) => {
          const last = s.values.length - 1;
          if (last < 0) return null;
          const lastValue = s.values[last] as number;
          return (
            <g key={s.name}>
              <path d={s.values.map((v, i) => `${i ? 'L' : 'M'}${xs(i)},${ys(v)}`).join('')} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={xs(last)} cy={ys(lastValue)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
              <text x={xs(last) + 9} y={ys(lastValue) + 4} fill="var(--ink-2)">
                {`${s.name} ${fmt(lastValue)}`}
              </text>
            </g>
          );
        })}
        {labels.map((lab, i) =>
          n > 10 && i % 2 ? null : (
            <text key={`l-${lab}`} x={xs(i)} y={H - 6} textAnchor="middle">
              {lab}
            </text>
          ),
        )}
        {labels.map((lab, i) => (
          <rect
            key={`h-${lab}`}
            className="hit"
            x={xs(i) - step / 2}
            y={padT}
            width={step}
            height={H - padT - padB}
            onMouseEnter={(e) =>
              tip.show(
                e,
                <>
                  <b>{lab}</b>
                  {series.map((s) => (
                    <TipLine key={s.name} color={s.color} name={s.name} value={fmt(s.values[i] ?? 0)} />
                  ))}
                </>,
              )
            }
            onMouseMove={tip.move}
            onMouseLeave={tip.hide}
          />
        ))}
      </svg>
      <Legend series={series} />
    </div>
  );
}
