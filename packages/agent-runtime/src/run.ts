/**
 * The session's one run. Every run event (contracts/run/v1/) is appended to
 * the transcript on disk as it arrives, numbered, so a dropped stream loses
 * nothing: `attach` replays from the file and continues live, and `status`
 * reads the ending from result.json.
 *
 * The harness's run.ended is held back, and the run records one run.ended of
 * its own as the last event: the harness's, unless the host stopped the run
 * at its time limit or the harness failed outside it.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { RUN_CONTRACT, type RunEnded, type RunEvent, type RunState, type RunStatus } from '@factorial/run';

export type { RunState } from '@factorial/run';

export interface RunRequest {
  prompt: string;
  round: number;
  workItemId?: string | undefined;
  attempt?: number | undefined;
}

/** One numbered transcript line. */
export interface Entry {
  seq: number;
  event: RunEvent;
}

export interface Limits {
  maxDurationMs: number;
  /** Stops the harness; the run then ends as incomplete. */
  abort: () => void;
}

export type StartRun = (request: RunRequest) => AsyncIterable<RunEvent>;

interface Subscriber {
  onEntry: (entry: Entry) => void;
  onEnd: () => void;
}

/** What a run.ended reports about the work done, kept when the host changes how the run ended. */
function figures(ended: RunEnded | undefined): Partial<RunEnded> {
  if (!ended) return {};
  const { turns, durationMs, cost, models, deniedToolCalls } = ended;
  return Object.fromEntries(Object.entries({ turns, durationMs, cost, models, deniedToolCalls }).filter(([, value]) => value !== undefined));
}

export class Run {
  private state: RunState = 'idle';
  private seq = 0;
  /** The harness's run.ended, held back until the run ends. */
  private harnessEnded: RunEnded | undefined;
  private ended: RunEnded | undefined;
  private timedOut = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly subscribers = new Set<Subscriber>();
  private readonly transcriptPath: string;
  private readonly resultPath: string;
  private readonly startRun: StartRun;
  private readonly onStateChange: (state: RunState) => void;
  private readonly limits: Limits | undefined;

  constructor(directory: string, startRun: StartRun, onStateChange: (state: RunState) => void = () => {}, limits?: Limits) {
    this.startRun = startRun;
    this.onStateChange = onStateChange;
    this.limits = limits;
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
    if (this.limits) {
      const { maxDurationMs, abort } = this.limits;
      this.timer = setTimeout(() => {
        this.timedOut = true;
        abort();
      }, maxDurationMs);
    }
    void this.consume(request);
    return true;
  }

  status(): RunStatus {
    return { contract: RUN_CONTRACT, state: this.state, events: this.seq, ...(this.ended ? { ended: this.ended } : {}) };
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
    let failure: string | undefined;
    try {
      for await (const event of this.startRun(request)) {
        if (event.type === 'run.ended') this.harnessEnded = event;
        else this.record(event);
      }
      if (this.harnessEnded === undefined) failure = 'the harness ended without a result';
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    this.finish(this.conclude(failure));
  }

  /**
   * How the run ended. A run stopped at its time limit is the rounds path,
   * like a turn limit, unless it had already succeeded. After an error result
   * (a turn or budget limit) the SDK also throws "Claude Code returned an
   * error result"; the result already says how the run ended, so the throw is
   * not a second ending: on #120 recording it made the stream disagree with
   * status, and a turn limit failed the build instead of continuing it. A
   * failure after a success, or with no result, fails the run.
   */
  private conclude(failure: string | undefined): RunEnded {
    const harness = this.harnessEnded;
    if (this.timedOut) {
      if (harness?.outcome === 'complete') return harness;
      return { type: 'run.ended', outcome: 'incomplete', reason: 'max_duration', ...(harness?.detail ? { detail: harness.detail } : {}), ...figures(harness) };
    }
    if (harness && (failure === undefined || harness.outcome !== 'complete')) return harness;
    return { type: 'run.ended', outcome: 'failed', reason: 'host_error', errors: [failure ?? 'the harness ended without a result'], ...figures(harness) };
  }

  private record(event: RunEvent): void {
    const entry: Entry = { seq: ++this.seq, event };
    appendFileSync(this.transcriptPath, `${JSON.stringify(entry)}\n`);
    for (const subscriber of this.subscribers) subscriber.onEntry(entry);
  }

  private finish(ended: RunEnded): void {
    clearTimeout(this.timer);
    this.ended = ended;
    this.record(ended);
    const state = ended.reason === 'host_error' ? 'failed' : 'finished';
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
