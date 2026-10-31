import type { ReactNode } from 'react';

import { Sparkline } from './charts/Sparkline.tsx';

/** A stat tile: label, value, sparkline, and a delta against a stated baseline. */
export function Tile({ label, value, unit, spark, delta }: { label: string; value: string; unit?: string; spark?: number[]; delta?: ReactNode }) {
  return (
    <div className="tile">
      <span className="label">{label}</span>
      <span className="value num">
        {value}
        {unit ? <small>{unit}</small> : null}
      </span>
      {spark ? <Sparkline values={spark} /> : <span />}
      {delta ? <span className="delta">{delta}</span> : null}
    </div>
  );
}

/** A delta's figure, coloured by whether the change is good. */
export function Delta({ text, good }: { text: string; good: boolean }) {
  return <span className={good ? 'up' : 'down'}>{text}</span>;
}
