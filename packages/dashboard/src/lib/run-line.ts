import type { LedgerRow, StageEntry } from './records.ts';
import { oneLine } from './sanitise.ts';
import { buildRounds } from './status.ts';

/*
 * The line under a stage's name on the work item page. The runtime name, its
 * version and the stop reason are written by the harness and the invoker, so
 * they are untrusted: each goes through `oneLine`, which removes control and
 * bidirectional characters and keeps it on one line.
 */

export type RunTone = 'plain' | 'waiting' | 'failed';

export interface RunLine {
  /** Runtime, turns and tool calls, joined by ' · '; may be empty. */
  lead: string;
  /** `stopped: <reason>`, when the run recorded a stop reason. */
  stopped?: string;
  /** How to colour `stopped`, from the run's outcome. */
  tone: RunTone;
}

const TONES: Record<string, RunTone> = { incomplete: 'waiting', failed: 'failed' };

function clean(value: unknown): string {
  return typeof value === 'string' ? oneLine(value) : '';
}

function count(value: unknown, noun: string): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? `${value} ${noun}` : undefined;
}

/** The run line for a stage entry, or undefined when it has no run or nothing to say. */
export function runLine(entry?: StageEntry): RunLine | undefined {
  const run = entry?.run;
  if (!run || typeof run !== 'object') return undefined;
  const name = clean(run.runtimeName);
  const version = clean(run.runtimeVersion);
  const runtime = [name, version ? `v${version}` : ''].filter(Boolean).join(' ');
  const parts = [runtime, count(run.turns, 'turns'), count(run.toolCalls, 'tool calls')].filter((p): p is string => Boolean(p));
  const reason = clean(run.stopReason);
  if (parts.length === 0 && !reason) return undefined;
  const line: RunLine = {
    lead: parts.join(' · '),
    tone: reason ? (TONES[String(run.outcome)] ?? 'plain') : 'plain',
  };
  if (reason) line.stopped = `stopped: ${reason}`;
  return line;
}

/** The whole line as plain text. */
export function runLineText(line: RunLine): string {
  return [line.lead, line.stopped].filter(Boolean).join(' · ');
}

/** `<n> build rounds` when the item took more than one build round. */
export function buildRoundsLabel(row: LedgerRow): string | undefined {
  const rounds = buildRounds(row);
  return rounds > 1 ? `${rounds} build rounds` : undefined;
}
