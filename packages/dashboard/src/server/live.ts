import 'server-only';

import { randomUUID } from 'node:crypto';

import { OrderedFeed, WORK_ITEMS_CHANNEL, chunkLines, chunkPath, liveEnvelope, parseEnvelope, type LiveEnvelope } from '@factorial/live';

import { realTimers, type ConnectionState, type Timers } from './live-connection.ts';

/**
 * The live stream (#57): one server-sent events stream per browser tab,
 * multiplexed over the channels the tab asks for, and one upstream
 * subscription per channel however many tabs want it.
 *
 * A run channel is delivered from its first event: the hub subscribes, reads
 * the run's catch-up chunks from the start, merges both by `seq` with
 * `OrderedFeed`, and keeps what it has sent, so a tab that joins later is
 * sent the same events from `seq` 1, once each, in order, then live until
 * `run.ended`. A work-item channel's progress is relayed as it comes, with
 * repeats dropped by `eventId`.
 */

/** What the stream sends a tab. */
export type LiveMessage =
  | { kind: 'hello'; stream: string }
  | { kind: 'event'; channel: string; envelope: LiveEnvelope }
  | { kind: 'progress'; channel: string; message: Record<string, unknown> }
  | { kind: 'state'; state: ConnectionState; channels: Record<string, ChannelState> };

export interface ChannelState {
  /** Events sent so far (a run), or messages (progress). */
  events: number;
  /** Catch-up chunks read (a run). */
  chunks?: number;
  /** The run sent `run.ended`. */
  ended?: boolean;
  /** The run's work item ended before the run's last event arrived. */
  incomplete?: boolean;
}

export interface Upstream {
  readonly current: ConnectionState;
  add(channel: string): void;
  remove(channel: string): void;
}

export interface UpstreamHandlers {
  onData(channel: string, events: unknown[]): void;
  onState(state: ConnectionState): void;
  onResubscribed(channel: string): void;
}

export interface HubOptions {
  upstream: (handlers: UpstreamHandlers) => Upstream;
  /** A catch-up chunk's text, or undefined until it exists. */
  chunk(key: string): Promise<string | undefined>;
  /** The item's attempt number, which its artefact prefix carries. */
  attemptOf(workItemId: string): Promise<number | undefined>;
  /** Whether the ledger says this run, or its whole item, has ended. */
  runOver(workItemId: string, stage: string, round: number): Promise<boolean>;
  timers?: Timers;
  /** How long after the first subscribe to read the chunks, and how often after. */
  firstPollMs?: number;
  pollMs?: number;
  /** How long a channel no tab wants is kept, so a tab moving between views does not resubscribe. */
  graceMs?: number;
  /** The most channels one tab may ask for. */
  maxChannels?: number;
  log?: (message: string) => void;
}

export interface Sink {
  send(message: LiveMessage): void;
  /** Called when the hub ends the stream (it is shutting down); the stream should end. */
  close?(): void;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RUN = new RegExp(`^/factorial/runs/(${UUID})/([a-z]+)/([1-9][0-9]{0,2})$`);
const ITEM = new RegExp(`^/factorial/work-items/(${UUID})$`);

export type ParsedChannel = { kind: 'run'; workItemId: string; stage: string; round: number } | { kind: 'progress' };

/** A channel a tab may ask for, or undefined. */
export function parseChannel(channel: unknown): ParsedChannel | undefined {
  if (typeof channel !== 'string') return undefined;
  if (channel === WORK_ITEMS_CHANNEL || ITEM.test(channel)) return { kind: 'progress' };
  const run = RUN.exec(channel);
  if (run) return { kind: 'run', workItemId: run[1] as string, stage: run[2] as string, round: Number(run[3]) };
  return undefined;
}

const ROLES: Record<string, string> = { build: 'builder', review: 'reviewer' };

interface Channel {
  readonly name: string;
  readonly tabs: Set<Tab>;
  drop?: unknown;
  state(): ChannelState;
  /** What a tab that has just joined is sent first. */
  replay(): LiveMessage[];
  receive(events: unknown[]): LiveMessage[];
  resubscribed(): void;
  stop(): void;
}

class ProgressChannel implements Channel {
  readonly tabs = new Set<Tab>();
  drop?: unknown;
  private readonly seen = new Set<string>();
  private count = 0;

  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  state(): ChannelState {
    return { events: this.count };
  }

  replay(): LiveMessage[] {
    return [];
  }

  receive(events: unknown[]): LiveMessage[] {
    const out: LiveMessage[] = [];
    for (const value of events) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const message = value as Record<string, unknown>;
      const id = typeof message.eventId === 'string' ? message.eventId : undefined;
      if (id) {
        if (this.seen.has(id)) continue;
        this.seen.add(id);
        if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value as string);
      }
      this.count += 1;
      out.push({ kind: 'progress', channel: this.name, message });
    }
    return out;
  }

  resubscribed(): void {}

  stop(): void {}
}

type RunOptions = Required<Pick<HubOptions, 'chunk' | 'attemptOf' | 'runOver' | 'firstPollMs' | 'pollMs'>> & { timers: Timers; log?: (m: string) => void };

class RunChannel implements Channel {
  readonly tabs = new Set<Tab>();
  drop?: unknown;
  private readonly feed = new OrderedFeed<LiveEnvelope>();
  private readonly history: LiveEnvelope[] = [];
  private chunksRead = 0;
  private attempt: number | undefined;
  private ended = false;
  private incomplete = false;
  private polling = false;
  private stopped = false;
  private quiet = 0;
  private timer: unknown;

  readonly name: string;
  private readonly target: { workItemId: string; stage: string; round: number };
  private readonly hub: LiveHub;
  private readonly options: RunOptions;

  constructor(name: string, target: { workItemId: string; stage: string; round: number }, hub: LiveHub, options: RunOptions) {
    this.name = name;
    this.target = target;
    this.hub = hub;
    this.options = options;
    this.schedule(options.firstPollMs);
  }

  state(): ChannelState {
    return { events: this.history.length, chunks: this.chunksRead, ...(this.ended ? { ended: true } : {}), ...(this.incomplete ? { incomplete: true } : {}) };
  }

  replay(): LiveMessage[] {
    return this.history.map((envelope) => ({ kind: 'event', channel: this.name, envelope }));
  }

  private take(envelope: LiveEnvelope): LiveMessage[] {
    const out: LiveMessage[] = [];
    for (const ready of this.feed.offer(envelope.seq, envelope)) {
      this.history.push(ready);
      out.push({ kind: 'event', channel: this.name, envelope: ready });
      if (ready.event.type === 'run.ended') this.ended = true;
    }
    return out;
  }

  receive(events: unknown[]): LiveMessage[] {
    const out: LiveMessage[] = [];
    for (const value of events) {
      const envelope = parseEnvelope(JSON.stringify(value));
      if (!envelope) continue;
      this.attempt ??= envelope.attempt;
      out.push(...this.take(envelope));
    }
    return out;
  }

  /** After a reconnect, events may have been missed: read the chunks again soon. */
  resubscribed(): void {
    if (this.stopped) return;
    this.quiet = 0;
    if (!this.polling) this.schedule(this.options.firstPollMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.options.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer !== undefined) this.options.timers.clearTimeout(this.timer);
    this.timer = this.options.timers.setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, ms);
  }

  /** Reads every chunk not yet read, in order, stopping at the first that does not exist yet. */
  private async readChunks(): Promise<number> {
    const { workItemId, stage, round } = this.target;
    this.attempt ??= await this.options.attemptOf(workItemId);
    if (this.attempt === undefined) return 0;
    let read = 0;
    for (;;) {
      const key = `${workItemId}/${this.attempt}/${chunkPath(stage, round, this.chunksRead + 1)}`;
      const text = await this.options.chunk(key);
      if (text === undefined || this.stopped) return read;
      this.chunksRead += 1;
      read += 1;
      const out: LiveMessage[] = [];
      for (const line of chunkLines(text)) {
        const { at, seq, ...event } = line;
        const published = parseEnvelope(
          liveEnvelope({ workItemId, attempt: this.attempt, role: ROLES[stage] ?? stage, stage, round }, seq, new Date(Date.parse(at) || 0), event),
        );
        if (published) out.push(...this.take(published));
      }
      this.hub.deliver(this, out);
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const read = await this.readChunks();
      if (this.ended && !this.feed.gap) {
        this.stop();
        return;
      }
      if (read === 0 && (await this.options.runOver(this.target.workItemId, this.target.stage, this.target.round))) {
        this.quiet += 1;
        // The run is over and the chunks have nothing more: it ended without its last event.
        if (this.quiet >= 3) {
          this.incomplete = true;
          this.stop();
          this.hub.changed();
          return;
        }
      } else if (read > 0) {
        this.quiet = 0;
      }
    } catch (error) {
      this.options.log?.(`catch-up not read for ${this.name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.polling = false;
    }
    this.hub.changed();
    this.schedule(this.options.pollMs);
  }
}

class Tab {
  readonly channels = new Set<string>();
  readonly id: string;
  readonly sink: Sink;

  constructor(id: string, sink: Sink) {
    this.id = id;
    this.sink = sink;
  }
}

/** Ends a tab's stream; one that fails to end must not stop the others. */
function endSink(sink: Sink): void {
  try {
    sink.close?.();
  } catch {
    // the stream has gone already
  }
}

export interface StreamHandle {
  readonly id: string;
  /** Replaces the channels this tab wants; returns those accepted. */
  setChannels(channels: unknown[]): string[];
  close(): void;
}

export class LiveHub {
  private readonly options: HubOptions;
  private readonly timers: Timers;
  private readonly channels = new Map<string, Channel>();
  private readonly tabs = new Map<string, Tab>();
  private upstream: Upstream | undefined;
  private connection: ConnectionState = 'idle';
  private flush: unknown;
  private closed = false;

  constructor(options: HubOptions) {
    this.options = options;
    this.timers = options.timers ?? realTimers;
  }

  private get up(): Upstream {
    this.upstream ??= this.options.upstream({
      onData: (channel, events) => {
        const target = this.channels.get(channel);
        if (target) this.deliver(target, target.receive(events));
      },
      onState: (state) => {
        this.connection = state;
        this.changed();
      },
      onResubscribed: (channel) => this.channels.get(channel)?.resubscribed(),
    });
    return this.upstream;
  }

  /** The upstream connection's state, for the Health view. */
  get connectionState(): ConnectionState {
    return this.upstream?.current ?? this.connection;
  }

  /** How many upstream subscriptions the hub holds. */
  get subscriptions(): number {
    return this.channels.size;
  }

  open(sink: Sink): StreamHandle {
    if (this.closed) {
      endSink(sink);
      return { id: '', setChannels: () => [], close: () => {} };
    }
    const tab = new Tab(randomUUID(), sink);
    this.tabs.set(tab.id, tab);
    this.send(tab, { kind: 'hello', stream: tab.id });
    this.sendState(tab);
    return {
      id: tab.id,
      setChannels: (channels) => this.setChannels(tab, channels),
      close: () => this.closeTab(tab),
    };
  }

  stream(id: string): StreamHandle | undefined {
    const tab = this.tabs.get(id);
    if (!tab) return undefined;
    return { id, setChannels: (channels) => this.setChannels(tab, channels), close: () => this.closeTab(tab) };
  }

  private setChannels(tab: Tab, requested: unknown[]): string[] {
    const wanted = [...new Set(requested.filter((c): c is string => parseChannel(c) !== undefined))].slice(0, this.options.maxChannels ?? 8);
    for (const name of [...tab.channels]) if (!wanted.includes(name)) this.leave(tab, name);
    for (const name of wanted) if (!tab.channels.has(name)) this.join(tab, name);
    this.sendState(tab);
    return wanted;
  }

  private join(tab: Tab, name: string): void {
    if (this.closed) return;
    let channel = this.channels.get(name);
    if (!channel) {
      const parsed = parseChannel(name);
      if (!parsed) return;
      channel =
        parsed.kind === 'run'
          ? new RunChannel(name, parsed, this, {
              chunk: this.options.chunk,
              attemptOf: this.options.attemptOf,
              runOver: this.options.runOver,
              firstPollMs: this.options.firstPollMs ?? 1000,
              pollMs: this.options.pollMs ?? 5000,
              timers: this.timers,
              ...(this.options.log ? { log: this.options.log } : {}),
            })
          : new ProgressChannel(name);
      this.channels.set(name, channel);
      this.up.add(name);
    }
    if (channel.drop !== undefined) {
      this.timers.clearTimeout(channel.drop);
      channel.drop = undefined;
    }
    channel.tabs.add(tab);
    tab.channels.add(name);
    for (const message of channel.replay()) this.send(tab, message);
  }

  private leave(tab: Tab, name: string): void {
    tab.channels.delete(name);
    const channel = this.channels.get(name);
    if (!channel) return;
    channel.tabs.delete(tab);
    if (channel.tabs.size > 0 || channel.drop !== undefined) return;
    channel.drop = this.timers.setTimeout(() => {
      channel.drop = undefined;
      if (channel.tabs.size > 0) return;
      channel.stop();
      this.channels.delete(name);
      this.up.remove(name);
    }, this.options.graceMs ?? 10_000);
  }

  private closeTab(tab: Tab): void {
    if (!this.tabs.delete(tab.id)) return;
    for (const name of [...tab.channels]) this.leave(tab, name);
  }

  /** Sends messages to every tab on the channel. */
  deliver(channel: Channel, messages: LiveMessage[]): void {
    if (messages.length === 0) return;
    for (const tab of [...channel.tabs]) for (const message of messages) this.send(tab, message);
    this.changed();
  }

  /** Something a tab's state shows has changed: tell every tab, at most once a second. */
  changed(): void {
    if (this.closed || this.flush !== undefined) return;
    this.flush = this.timers.setTimeout(() => {
      this.flush = undefined;
      for (const tab of this.tabs.values()) this.sendState(tab);
    }, 1000);
  }

  /**
   * Shuts the hub down (the process was asked to stop): ends every tab's
   * stream, drops every upstream subscription, which closes the upstream
   * connection, and stops every timer, so nothing keeps the server alive.
   * Nothing is sent to the tabs; their streams just end. Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.flush !== undefined) this.timers.clearTimeout(this.flush);
    this.flush = undefined;
    for (const [name, channel] of this.channels) {
      if (channel.drop !== undefined) this.timers.clearTimeout(channel.drop);
      channel.drop = undefined;
      channel.stop();
      channel.tabs.clear();
      this.upstream?.remove(name);
    }
    this.channels.clear();
    const tabs = [...this.tabs.values()];
    this.tabs.clear();
    for (const tab of tabs) {
      tab.channels.clear();
      endSink(tab.sink);
    }
  }

  private sendState(tab: Tab): void {
    const channels: Record<string, ChannelState> = {};
    for (const name of tab.channels) {
      const channel = this.channels.get(name);
      if (channel) channels[name] = channel.state();
    }
    this.send(tab, { kind: 'state', state: this.upstream?.current ?? this.connection, channels });
  }

  /** A tab whose stream has gone is closed. */
  private send(tab: Tab, message: LiveMessage): void {
    if (!this.tabs.has(tab.id)) return;
    try {
      tab.sink.send(message);
    } catch {
      this.closeTab(tab);
    }
  }
}
