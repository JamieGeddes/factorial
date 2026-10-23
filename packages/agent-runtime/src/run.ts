/**
 * The session's one run. Every message is appended to the transcript on disk as
 * it arrives, numbered, so a dropped stream loses nothing: `attach` replays from
 * the file and continues live, and `status` reads the outcome from result.json.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { outcomeOf, type Outcome } from './outcome.ts';

export type RunState = 'idle' | 'running' | 'finished' | 'failed';

export interface RunRequest {
  prompt: string;
  round: number;
  workItemId?: string | undefined;
  attempt?: number | undefined;
}

/** One numbered transcript line. */
export interface Entry {
  seq: number;
  message: unknown;
}

export interface RunStatus {
  state: RunState;
  messages: number;
  outcome?: Outcome;
  result?: unknown;
  error?: string;
}

/** A message the host adds to the stream when the run fails outside the SDK. */
export const HOST_ERROR = 'factorial_host_error';

export type StartQuery = (request: RunRequest) => AsyncIterable<unknown>;

interface Subscriber {
  onEntry: (entry: Entry) => void;
  onEnd: () => void;
}

function isResult(message: unknown): message is { type: 'result'; subtype: Parameters<typeof outcomeOf>[0] } {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'result';
}

export class Run {
  private state: RunState = 'idle';
  private seq = 0;
  private result: unknown;
  private error: string | undefined;
  private readonly subscribers = new Set<Subscriber>();
  private readonly transcriptPath: string;
  private readonly resultPath: string;
  private readonly startQuery: StartQuery;
  private readonly onStateChange: (state: RunState) => void;

  constructor(directory: string, startQuery: StartQuery, onStateChange: (state: RunState) => void = () => {}) {
    this.startQuery = startQuery;
    this.onStateChange = onStateChange;
    mkdirSync(directory, { recursive: true });
    this.transcriptPath = path.join(directory, 'transcript.jsonl');
    this.resultPath = path.join(directory, 'result.json');
  }

  get current(): RunState {
    return this.state;
  }

  /** Starts the run. Returns false when the session has already had one. */
  start(request: RunRequest): boolean {
    if (this.state !== 'idle') return false;
    this.setState('running');
    void this.consume(request);
    return true;
  }

  status(): RunStatus {
    const status: RunStatus = { state: this.state, messages: this.seq };
    if (isResult(this.result)) {
      status.outcome = outcomeOf(this.result.subtype);
      status.result = this.result;
    }
    if (this.error !== undefined) status.error = this.error;
    return status;
  }

  /**
   * Replays every entry after `after` from the transcript, then delivers new
   * entries as they arrive, then calls onEnd. Reading the file and registering
   * the subscriber happen in one synchronous step, so no entry is missed or
   * repeated between them.
   */
  subscribe(after: number, onEntry: (entry: Entry) => void, onEnd: () => void): () => void {
    for (const entry of this.readTranscript()) {
      if (entry.seq > after) onEntry(entry);
    }
    if (this.state !== 'running') {
      onEnd();
      return () => {};
    }
    const subscriber = { onEntry, onEnd };
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private readTranscript(): Entry[] {
    if (!existsSync(this.transcriptPath)) return [];
    return readFileSync(this.transcriptPath, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Entry);
  }

  private async consume(request: RunRequest): Promise<void> {
    try {
      for await (const message of this.startQuery(request)) {
        this.record(message);
        if (isResult(message)) this.result = message;
      }
      if (this.result === undefined) throw new Error('the SDK ended without a result message');
      this.finish('finished');
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.record({ type: HOST_ERROR, error: this.error });
      this.finish('failed');
    }
  }

  private record(message: unknown): void {
    const entry: Entry = { seq: ++this.seq, message };
    appendFileSync(this.transcriptPath, `${JSON.stringify(entry)}\n`);
    for (const subscriber of this.subscribers) subscriber.onEntry(entry);
  }

  private finish(state: 'finished' | 'failed'): void {
    writeFileSync(this.resultPath, `${JSON.stringify({ ...this.status(), state }, null, 2)}\n`);
    this.setState(state);
    for (const subscriber of this.subscribers) subscriber.onEnd();
    this.subscribers.clear();
  }

  private setState(state: RunState): void {
    this.state = state;
    this.onStateChange(state);
  }
}
