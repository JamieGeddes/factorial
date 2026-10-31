/**
 * Reading a run from the agent runtime's host (packages/agent-runtime). The
 * host streams each SDK message as a server-sent event whose id is the
 * message's number. AgentCore does not document how long one streaming
 * invocation may last, so when a stream ends before the run has, the invoker
 * re-invokes the same session with `attach` and the number of the last
 * message it has, and the host replays from its transcript and carries on.
 */

export interface SseEvent {
  id: number | undefined;
  data: unknown;
}

/** Splits a byte stream into server-sent events with JSON data. */
export async function* parseSse(stream: AsyncIterable<Uint8Array | string>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let id: number | undefined;
  let data: string[] = [];
  const flush = (): SseEvent | undefined => {
    if (data.length === 0) return undefined;
    const event = { id, data: JSON.parse(data.join('\n')) as unknown };
    id = undefined;
    data = [];
    return event;
  };
  /** Takes one line; returns an event when the line ends one. */
  const take = (line: string): SseEvent | undefined => {
    if (line === '') return flush();
    if (line.startsWith('id:')) id = Number(line.slice(3).trim());
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    return undefined;
  };
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const event = take(buffer.slice(0, newline).replace(/\r$/, ''));
      buffer = buffer.slice(newline + 1);
      if (event) yield event;
    }
  }
  // A stream cut short can end mid-event, without its blank line.
  take(buffer.replace(/\r$/, ''));
  const last = flush();
  if (last) yield last;
}

/** Sends one invocation payload to the session and returns the response stream. */
export type InvokeSession = (payload: object) => Promise<AsyncIterable<Uint8Array | string>>;

export interface StreamOptions {
  /** How many times to re-attach after a stream ends early. */
  maxReconnects: number;
  delayMs: number;
  sleep?: (ms: number) => Promise<void>;
  onReconnect?: (attempt: number, after: number, reason: string) => void;
}

/** A 409 from the host: the session already has a run, or has none to attach to. */
export function isConflict(error: unknown): boolean {
  return error instanceof Error && /\(409\)/.test(error.message);
}

/**
 * Runs the session's one run to its end, delivering every message once and
 * in order, with its number. Returns how many times it re-attached. `ended` says whether the
 * messages so far include the run's end.
 */
export async function streamRun(
  invoke: InvokeSession,
  run: object,
  onMessage: (message: unknown, seq: number) => void,
  ended: () => boolean,
  options: StreamOptions,
): Promise<number> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastSeq = 0;
  let payload: object = run;
  let reconnects = 0;
  for (;;) {
    let reason = 'the stream ended before the run did';
    try {
      for await (const event of parseSse(await invoke(payload))) {
        // Every message carries its number. A replayed one is dropped; a gap
        // or a missing number is treated as a broken stream and re-attached
        // from the last message delivered, so none is skipped.
        if (event.id !== undefined && Number.isInteger(event.id) && event.id <= lastSeq) continue;
        if (event.id !== lastSeq + 1) throw new Error(`expected message ${lastSeq + 1}, got ${String(event.id)}`);
        lastSeq = event.id;
        onMessage(event.data, event.id);
      }
      if (ended()) return reconnects;
    } catch (error) {
      // A 409 on the first run means it already started (a retried call); attach to it.
      // A 409 on attach means the session has no run, which no retry fixes.
      if (isConflict(error) && payload !== run) throw error;
      reason = error instanceof Error ? error.message : String(error);
    }
    if (reconnects >= options.maxReconnects) {
      throw new Error(`the run's stream ended without its result after ${reconnects} reconnects: ${reason}`);
    }
    reconnects += 1;
    options.onReconnect?.(reconnects, lastSeq, reason);
    await sleep(options.delayMs);
    payload = { action: 'attach', after: lastSeq };
  }
}
