import { buildRoundsLabel } from '../lib/run-line.ts';
import type { LedgerRow } from '../lib/records.ts';
import { Tag } from './Tag.tsx';

/** `<n> build rounds`, for an item that took more than one. */
export function BuildRoundsTag({ row }: { row: LedgerRow }) {
  const label = buildRoundsLabel(row);
  return label ? <Tag>{label}</Tag> : null;
}
