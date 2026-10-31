/**
 * How the launcher (`start.ts`) stops the server: the timing of the grace
 * period and the second signal, apart from Node's process and timers so a test
 * can drive it without spawning Next.js.
 *
 * The first SIGINT or SIGTERM is forwarded to the server, which ends its live
 * streams and exits. If it is still running `GRACE_MS` later, or a second
 * signal arrives, it is killed. The server is read-only and holds no state, so
 * a forced stop loses nothing.
 */
export const GRACE_MS = 5000;

export type StopSignal = 'SIGINT' | 'SIGTERM';

/** The conventional exit code for a process ended by the signal (128 + its number). */
const CODES: Record<StopSignal, number> = { SIGINT: 130, SIGTERM: 143 };

export interface ShutdownOptions {
  /** Passes the signal on to the server. */
  forward(signal: StopSignal): void;
  /** Kills the server with SIGKILL. */
  kill(): void;
  /** Ends the launcher. */
  exit(code: number): void;
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  graceMs?: number;
}

export interface Shutdown {
  /** The launcher received SIGINT or SIGTERM. */
  signal(signal: StopSignal): void;
  /** The server has exited. */
  exited(code: number | null): void;
}

export function createShutdown(options: ShutdownOptions): Shutdown {
  let first: StopSignal | undefined;
  let timer: unknown;
  let done = false;

  const finish = (code: number): void => {
    if (done) return;
    done = true;
    if (timer !== undefined) options.timers.clearTimeout(timer);
    timer = undefined;
    options.exit(code);
  };

  return {
    signal(signal) {
      if (done) return;
      if (first === undefined) {
        first = signal;
        options.forward(signal);
        timer = options.timers.setTimeout(() => {
          timer = undefined;
          options.kill();
          finish(CODES[signal]);
        }, options.graceMs ?? GRACE_MS);
        return;
      }
      options.kill();
      finish(CODES[signal]);
    },
    exited(code) {
      finish(code ?? (first ? CODES[first] : 0));
    },
  };
}
