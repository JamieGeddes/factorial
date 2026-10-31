import 'server-only';

/**
 * One WebSocket to the AppSync Events API for the whole server, with one
 * subscription per channel however many tabs want it (#57). It reconnects
 * with backoff, as `scripts/tail-run.ts` does, and subscribes again to every
 * channel it held; the hub reads the catch-up chunks again so a reconnect
 * leaves no gap.
 */
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'down';

export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void;
}

export interface Authoriser {
  /** The subprotocols that open an authorised connection. */
  protocols(): Promise<string[]>;
  /** The headers that authorise subscribing to one channel. */
  subscribe(channel: string): Promise<Record<string, string>>;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ConnectionOptions {
  /** The real-time endpoint, `wss://<realtime domain>/event/realtime`. */
  url: () => Promise<string>;
  socket: (url: string, protocols: string[]) => SocketLike;
  auth: Authoriser;
  timers?: Timers;
  onData(channel: string, events: unknown[]): void;
  onState(state: ConnectionState): void;
  /** A channel was subscribed again after a reconnect. */
  onResubscribed?(channel: string): void;
  /** Failed attempts in a row before the state reads `down`; it keeps trying. */
  downAfter?: number;
  log?: (message: string) => void;
}

/** A data message's events: AppSync sends them as JSON strings, singly or in a list. */
export function dataEvents(message: { event?: unknown }): unknown[] {
  const raw = Array.isArray(message.event) ? message.event : [message.event];
  return raw.flatMap((value) => {
    if (typeof value !== 'string') return value === undefined ? [] : [value];
    try {
      return [JSON.parse(value) as unknown];
    } catch {
      return [];
    }
  });
}

export function backoffMs(failures: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1));
}

interface Subscription {
  id: string;
  /** Subscribed on the current socket. */
  active: boolean;
  /** Subscribed on an earlier socket: the next success is a resubscription. */
  before: boolean;
}

export class LiveConnection {
  private readonly timers: Timers;
  private readonly channels = new Map<string, Subscription>();
  private readonly byId = new Map<string, string>();
  private socket: SocketLike | undefined;
  private acked = false;
  private failures = 0;
  private retry: unknown;
  private keepAlive: unknown;
  private timeoutMs = 300_000;
  private state: ConnectionState = 'idle';
  private nextId = 0;
  private opening = false;

  private readonly options: ConnectionOptions;

  constructor(options: ConnectionOptions) {
    this.options = options;
    this.timers = options.timers ?? realTimers;
  }

  get current(): ConnectionState {
    return this.state;
  }

  has(channel: string): boolean {
    return this.channels.has(channel);
  }

  add(channel: string): void {
    if (this.channels.has(channel)) return;
    this.nextId += 1;
    const id = `s${this.nextId}`;
    this.channels.set(channel, { id, active: false, before: false });
    this.byId.set(id, channel);
    if (!this.socket && this.retry === undefined && !this.opening) void this.open();
    else if (this.acked) void this.subscribe(channel);
  }

  remove(channel: string): void {
    const sub = this.channels.get(channel);
    if (!sub) return;
    this.channels.delete(channel);
    this.byId.delete(sub.id);
    if (this.acked && sub.active) this.sendSafe({ type: 'unsubscribe', id: sub.id });
    if (this.channels.size === 0) this.close();
  }

  /** Closes the socket and stops reconnecting; channels added later open a new one. */
  close(): void {
    if (this.retry !== undefined) this.timers.clearTimeout(this.retry);
    this.retry = undefined;
    this.clearKeepAlive();
    const socket = this.socket;
    this.socket = undefined;
    this.acked = false;
    this.failures = 0;
    for (const sub of this.channels.values()) sub.active = false;
    socket?.close();
    this.setState(this.channels.size === 0 ? 'idle' : 'down');
  }

  private setState(state: ConnectionState): void {
    if (state === this.state) return;
    this.state = state;
    this.options.onState(state);
  }

  private sendSafe(message: object): void {
    try {
      this.socket?.send(JSON.stringify(message));
    } catch {
      // A send on a closing socket is lost; the reconnect subscribes again.
    }
  }

  private async open(): Promise<void> {
    this.retry = undefined;
    this.setState(this.failures === 0 ? 'connecting' : this.failures >= (this.options.downAfter ?? 5) ? 'down' : 'reconnecting');
    let socket: SocketLike;
    this.opening = true;
    try {
      socket = this.options.socket(await this.options.url(), await this.options.auth.protocols());
    } catch (error) {
      this.opening = false;
      this.options.log?.(`live connection not opened: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleRetry();
      return;
    }
    this.opening = false;
    if (this.channels.size === 0) {
      socket.close();
      this.setState('idle');
      return;
    }
    this.socket = socket;
    this.acked = false;
    socket.addEventListener('open', () => this.sendSafe({ type: 'connection_init' }));
    socket.addEventListener('message', (event) => this.receive(socket, event.data));
    socket.addEventListener('close', () => this.lost(socket));
    socket.addEventListener('error', () => this.lost(socket));
  }

  private lost(socket: SocketLike): void {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.acked = false;
    this.clearKeepAlive();
    for (const sub of this.channels.values()) {
      if (sub.active) sub.before = true;
      sub.active = false;
    }
    if (this.channels.size === 0) {
      this.setState('idle');
      return;
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    this.failures += 1;
    this.setState(this.failures >= (this.options.downAfter ?? 5) ? 'down' : 'reconnecting');
    this.retry = this.timers.setTimeout(() => void this.open(), backoffMs(this.failures));
  }

  private clearKeepAlive(): void {
    if (this.keepAlive !== undefined) this.timers.clearTimeout(this.keepAlive);
    this.keepAlive = undefined;
  }

  private armKeepAlive(socket: SocketLike): void {
    this.clearKeepAlive();
    this.keepAlive = this.timers.setTimeout(() => {
      // Nothing heard, not even a keep-alive: treat the connection as lost.
      if (socket === this.socket) {
        socket.close();
        this.lost(socket);
      }
    }, this.timeoutMs);
  }

  private async subscribe(channel: string): Promise<void> {
    const sub = this.channels.get(channel);
    if (!sub || !this.socket) return;
    const socket = this.socket;
    let authorization: Record<string, string>;
    try {
      authorization = await this.options.auth.subscribe(channel);
    } catch (error) {
      this.options.log?.(`live subscription not signed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (socket !== this.socket || this.channels.get(channel) !== sub) return;
    this.sendSafe({ type: 'subscribe', id: sub.id, channel, authorization });
  }

  private receive(socket: SocketLike, raw: unknown): void {
    if (socket !== this.socket) return;
    let message: { type?: string; id?: string; event?: unknown; connectionTimeoutMs?: unknown; errors?: unknown };
    try {
      message = JSON.parse(String(raw)) as typeof message;
    } catch {
      return;
    }
    this.armKeepAlive(socket);
    switch (message.type) {
      case 'connection_ack':
        this.acked = true;
        this.failures = 0;
        if (typeof message.connectionTimeoutMs === 'number' && message.connectionTimeoutMs > 0) this.timeoutMs = message.connectionTimeoutMs;
        this.armKeepAlive(socket);
        this.setState('connected');
        for (const channel of this.channels.keys()) void this.subscribe(channel);
        return;
      case 'subscribe_success': {
        const channel = message.id ? this.byId.get(message.id) : undefined;
        const sub = channel ? this.channels.get(channel) : undefined;
        if (!channel || !sub) return;
        sub.active = true;
        if (sub.before) this.options.onResubscribed?.(channel);
        return;
      }
      case 'data': {
        const channel = message.id ? this.byId.get(message.id) : undefined;
        if (channel) this.options.onData(channel, dataEvents(message));
        return;
      }
      case 'subscribe_error':
      case 'connection_error':
      case 'error':
        this.options.log?.(`live feed: ${message.type} ${JSON.stringify(message.errors ?? '').slice(0, 300)}`);
        if (message.type !== 'subscribe_error') {
          socket.close();
          this.lost(socket);
        }
        return;
      default:
        return;
    }
  }
}
