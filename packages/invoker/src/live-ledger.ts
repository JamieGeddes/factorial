/**
 * The run's progress on its ledger row while it runs (#194): one attribute,
 * `live`, replaced whole every 60 seconds and on `run.started` and
 * `run.ended`, and kept with its final values once the run ends. A view for
 * readers (#57's `GET /running`); nothing in the pipeline reads it.
 *
 * Mid-run, `turns` is unknown and `costUsd` is the sum of the hosts' per-call
 * estimates (`model.call` `cost`), present once a host sends them. After
 * `run.ended` both are the harness's figures, and `usage` is the run's, as
 * usage.json records it.
 */
import { realTimers, type ThrottledReport, type Timers } from './live-publisher.ts';
import { roundUsd, type VersionInfo } from './run-record.ts';
import { runUsageOf, type RunTally } from './run-events.ts';
import { addCallUsage, emptyRunUsage, type RunUsage } from './usage.ts';

export interface LiveSnapshot {
  role: string;
  stage: string;
  round: number;
  /** When this snapshot was written. */
  at: string;
  /** The last event's stream number. */
  seq: number;
  events: number;
  toolCalls: number;
  /** Model calls so far, the main agent's and its subagents'. */
  modelCalls: number;
  turns?: number;
  usage: RunUsage;
  costUsd?: number;
  elapsedSeconds: number;
  lastEvent?: { type: string; at: string };
  limits: { maxTurns?: number; maxBudgetUsd?: number; maxDurationSeconds?: number };
  /** Set once the run has ended (or the invoker has stopped). */
  ended?: true;
}

export interface SnapshotInput {
  role: string;
  stage: string;
  round: number;
  now: Date;
  startedAt: number;
  seq: number;
  events: number;
  lastEvent: { type: string; at: string } | undefined;
  tally: RunTally;
  version: VersionInfo;
  ended: boolean;
}

export function liveSnapshot(input: SnapshotInput): LiveSnapshot {
  const { tally, version } = input;
  const end = tally.end;
  const usage = end ? runUsageOf(tally) : tally.calls.reduce(addCallUsage, emptyRunUsage());
  const costUsd = end?.cost ? end.cost.usd : tally.costedCalls > 0 ? tally.callCostUsd : undefined;
  return {
    role: input.role,
    stage: input.stage,
    round: input.round,
    at: input.now.toISOString(),
    seq: input.seq,
    events: input.events,
    toolCalls: tally.toolCalls,
    modelCalls: usage.modelCalls,
    ...(end?.turns !== undefined ? { turns: end.turns } : {}),
    usage,
    ...(costUsd !== undefined ? { costUsd: roundUsd(costUsd) } : {}),
    elapsedSeconds: Math.max(0, Math.round((input.now.getTime() - input.startedAt) / 1000)),
    ...(input.lastEvent ? { lastEvent: input.lastEvent } : {}),
    limits: {
      ...(version.maxTurns !== undefined ? { maxTurns: version.maxTurns } : {}),
      ...(version.maxBudgetUsd !== undefined ? { maxBudgetUsd: version.maxBudgetUsd } : {}),
      ...(version.maxDurationSeconds !== undefined ? { maxDurationSeconds: version.maxDurationSeconds } : {}),
    },
    ...(input.ended ? { ended: true as const } : {}),
  };
}

export interface LedgerOptions {
  /** Replaces the row's `live` attribute. */
  write: (snapshot: LiveSnapshot) => Promise<void>;
  snapshot: (ended: boolean) => LiveSnapshot;
  report: ThrottledReport;
  intervalMs?: number;
  timers?: Timers;
}

export class LiveLedger {
  private readonly options: Required<LedgerOptions>;
  private chain: Promise<void> = Promise.resolve();
  private timer: unknown;
  private stopped = false;
  writes = 0;
  failures = 0;

  constructor(options: LedgerOptions) {
    this.options = { intervalMs: 60_000, timers: realTimers, ...options };
  }

  /** Start writing every interval. */
  start(): void {
    this.arm();
  }

  private arm(): void {
    if (this.stopped) return;
    this.timer = this.options.timers.set(() => {
      this.timer = undefined;
      this.now();
      this.arm();
    }, this.options.intervalMs);
  }

  /** Write a snapshot now, after any write already queued. Never throws. */
  now(ended = false): void {
    if (this.stopped) return;
    this.enqueue(ended);
  }

  /** The snapshot is taken now, so it says what was true when it was asked for; writes go one at a time. */
  private enqueue(ended: boolean): void {
    let snapshot: LiveSnapshot;
    try {
      snapshot = this.options.snapshot(ended);
    } catch (error) {
      this.failures += 1;
      this.options.report.failed(error);
      return;
    }
    this.chain = this.chain.then(async () => {
      try {
        await this.options.write(snapshot);
        this.writes += 1;
      } catch (error) {
        this.failures += 1;
        this.options.report.failed(error);
      }
    });
  }

  /** Stop the timer and write the final snapshot. */
  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      if (this.timer !== undefined) this.options.timers.clear(this.timer);
      this.timer = undefined;
      this.enqueue(true);
    }
    await this.chain;
  }
}
