/** The stage and round a `stages` key names: `Build`, `Build#2`. As `parseStageKey` in `@factorial/progress`, which this cannot import into a browser bundle. */
export function parseStageKey(key: string): { stage: string; round?: number } {
  const [stage = key, round] = key.split('#');
  const n = Number(round);
  return round === undefined || !Number.isInteger(n) ? { stage } : { stage, round: n };
}
