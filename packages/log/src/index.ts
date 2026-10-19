/**
 * Structured logging. Every line is one JSON object carrying the run's key,
 * `workItemId` and `attempt`, and the `stage` that wrote it, so a single Logs
 * Insights filter on `workItemId` finds every line of a run across the
 * orchestrator Lambdas and the invoker. Lines are redacted before they are
 * written: errors from git and GitHub can echo a token.
 */
import { redactSecrets } from '@factorial/artefacts';

/** Which run a line belongs to. Either part may be unknown early in a stage. */
export interface RunKey {
  workItemId?: string | undefined;
  attempt?: number | undefined;
}

export type Fields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  /** The same stage's logger with the run's key set, once it is known. */
  with(key: RunKey): Logger;
}

/** Keys every line sets itself; fields cannot replace them. */
const RESERVED = new Set(['workItemId', 'attempt', 'stage', 'level', 'message']);

function serialisable(_key: string, value: unknown): unknown {
  return value instanceof Error ? `${value.name}: ${value.message}` : value;
}

export function logLine(stage: string, key: RunKey, level: 'info' | 'error', message: string, fields: Fields = {}): string {
  const extra = Object.fromEntries(Object.entries(fields).filter(([name]) => !RESERVED.has(name)));
  const line = { workItemId: key.workItemId, attempt: key.attempt, stage, level, message, ...extra };
  return redactSecrets(JSON.stringify(line, serialisable));
}

export function createLogger(stage: string, key: RunKey = {}, write: (line: string) => void = console.log): Logger {
  return {
    info: (message, fields) => write(logLine(stage, key, 'info', message, fields)),
    error: (message, fields) => write(logLine(stage, key, 'error', message, fields)),
    with: (next) => createLogger(stage, { ...key, ...next }, write),
  };
}
