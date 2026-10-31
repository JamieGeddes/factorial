/**
 * The live feed of one run (#194): every event the invoker receives goes to
 * the run's channel (live-publisher.ts), its transcript line to the catch-up
 * chunks (live-chunks.ts), and the run's progress to the ledger row's `live`
 * attribute (live-ledger.ts). A view of what the invoker already holds: no new
 * path out of the session, and nothing here can fail the run or change its
 * record; every failure is counted and reported at most once a minute.
 */
import { liveEnvelope, type EnvelopeContext, type PublishBatch } from '@factorial/live';

import { LiveChunks, type ChunkSummary } from './live-chunks.ts';
import { LiveLedger, type LiveSnapshot } from './live-ledger.ts';
import { LivePublisher, ThrottledReport, realTimers, type Timers } from './live-publisher.ts';

/** What the feed has seen, for the ledger snapshot. */
export interface FeedState {
  seq: number;
  events: number;
  lastEvent: { type: string; at: string } | undefined;
}

/** What usage.json records about the feed. */
export interface LiveRecord {
  published: number;
  dropped: number;
  chunks: ChunkSummary;
}

export interface FeedOptions {
  context: EnvelopeContext;
  channel: string;
  /** Undefined when the invoker has no endpoint: every event is dropped. */
  send: PublishBatch | undefined;
  /** Undefined when the run has no artefact prefix: no chunks. */
  putChunk: ((n: number, text: string) => Promise<void>) | undefined;
  writeLive: (snapshot: LiveSnapshot) => Promise<void>;
  snapshot: (state: FeedState, ended: boolean) => LiveSnapshot;
  /** How a failure is reported (an error log line). */
  report: (message: string, fields: Record<string, unknown>) => void;
  /** How long the end of the run waits for the last publishes. */
  closeTimeoutMs?: number;
  timers?: Timers;
  now?: () => number;
}

export class LiveFeed {
  private readonly state: FeedState = { seq: 0, events: 0, lastEvent: undefined };
  private readonly options: FeedOptions;
  private readonly publisher: LivePublisher;
  private readonly chunks: LiveChunks | undefined;
  private readonly ledger: LiveLedger;
  private readonly problems: ThrottledReport;
  private closing: Promise<LiveRecord> | undefined;

  constructor(options: FeedOptions) {
    this.options = options;
    const timers = options.timers ?? realTimers;
    const report = (message: string) => new ThrottledReport(options.report, message, 60_000, options.now);
    this.publisher = new LivePublisher({ channel: options.channel, send: options.send, report: report('live publish failed'), timers });
    this.chunks = options.putChunk ? new LiveChunks({ put: options.putChunk, report: report('live chunk not stored'), timers }) : undefined;
    this.ledger = new LiveLedger({
      write: options.writeLive,
      snapshot: (ended) => options.snapshot({ ...this.state }, ended),
      report: report('live progress not recorded'),
      timers,
    });
    this.problems = report('live feed failed');
  }

  /** Write the ledger every minute from now on. */
  start(): void {
    this.ledger.start();
  }

  /** One run event as received, and the transcript line it became (none past the cap). Never throws. */
  event(message: unknown, seq: number, at: Date, line: string | undefined): void {
    try {
      const type = typeof (message as { type?: unknown } | null)?.type === 'string' ? (message as { type: string }).type : 'unknown';
      this.state.seq = seq;
      this.state.events += 1;
      this.state.lastEvent = { type, at: at.toISOString() };
      if (line !== undefined) this.chunks?.add(line, seq);
      this.publisher.add(liveEnvelope(this.options.context, seq, at, message));
      if (type === 'run.started' || type === 'run.ended') this.ledger.now();
    } catch (error) {
      this.problems.failed(error, { seq });
    }
  }

  /** Publish what is left, store the last chunk and write the final progress. Once, however often it is called. */
  close(): Promise<LiveRecord> {
    this.closing ??= (async () => {
      const [sent, chunks] = await Promise.all([this.publisher.close(this.options.closeTimeoutMs ?? 5000), this.chunks?.close()]);
      await this.ledger.stop();
      return { ...sent, chunks: chunks ?? { count: 0, failed: 0 } };
    })();
    return this.closing;
  }
}
