/**
 * Catch-up chunks: while a run goes on, the invoker uploads the transcript
 * lines received since its last upload as `<stage>/live/<n>.jsonl` (`n` from
 * 1, four digits; a round after the first under `<stage>/round-<r>/live/`).
 * Each line is the transcript's own, redacted and uncut, with its `seq`.
 * Each key is written once. A reader subscribes first, then reads the chunks,
 * then drops any event whose `seq` it already has.
 */
export const CHUNK_EVENTS = 200;
export const CHUNK_SECONDS = 30;

/** The folder a run's records go in, under the attempt's prefix. */
export function runFolder(stage: string, round: number): string {
  return round > 1 ? `${stage}/round-${round}` : stage;
}

/** The artefact path of a run's chunk `n`. */
export function chunkPath(stage: string, round: number, n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error(`chunk ${n} is not a positive integer`);
  return `${runFolder(stage, round)}/live/${String(n).padStart(4, '0')}.jsonl`;
}

/** One line of a chunk, or of the transcript: the run event with `at` and `seq`. */
export interface ChunkLine {
  at: string;
  seq: number;
  [field: string]: unknown;
}

/** The events in a chunk's text, in order; lines without a `seq` (the request line, the truncation marker) are skipped. */
export function chunkLines(text: string): ChunkLine[] {
  const lines: ChunkLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const line = JSON.parse(raw) as Partial<ChunkLine>;
      if (Number.isInteger(line.seq)) lines.push(line as ChunkLine);
    } catch {
      // A torn line is skipped; the final transcript is the record.
    }
  }
  return lines;
}
