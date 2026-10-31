import type { Pill as PillValue } from '../lib/status.ts';

/** A status pill; `note` goes on the line under it. */
export function Pill({ pill, withNote = false }: { pill: PillValue; withNote?: boolean }) {
  return (
    <>
      <span className={`pill ${pill.tone}`}>{pill.label}</span>
      {withNote && pill.note ? <span className="sub">{pill.note}</span> : null}
    </>
  );
}

export function RolePill({ children }: { children: string }) {
  return <span className="pill role">{children}</span>;
}
