/**
 * The AgentCore Runtime container contract: GET /ping and POST /invocations on
 * port 8080. /ping reports HealthyBusy while the run is in progress, which keeps
 * the session alive past its idle timeout. /invocations takes one of three
 * actions:
 * - run: start the session's one run and stream its messages as server-sent
 *   events, one numbered SDK message per event; 409 if the session has had one.
 * - attach: stream the messages after `after` (default 0), replayed from the
 *   transcript, then live until the run ends; 409 if no run has started.
 * - status: the run's state and, once finished, its outcome and result message.
 */
import http from 'node:http';

import type { Run, RunRequest } from './run.ts';

const MAX_BODY_BYTES = 1024 * 1024;

export interface Ping {
  status: 'Healthy' | 'HealthyBusy';
  time_of_last_update: number;
}

type Invocation =
  | { action: 'run'; request: RunRequest }
  | { action: 'attach'; after: number }
  | { action: 'status' };

/** Validates a request body; returns an error message for anything else. */
export function parseInvocation(body: unknown): Invocation | string {
  if (typeof body !== 'object' || body === null) return 'body must be a JSON object';
  const fields = body as Record<string, unknown>;
  switch (fields.action) {
    case 'run': {
      if (typeof fields.prompt !== 'string' || fields.prompt.trim().length === 0) return 'run needs a prompt';
      if (!Number.isInteger(fields.round) || (fields.round as number) < 1) return 'run needs a round of 1 or more';
      const workItemId = typeof fields.workItemId === 'string' ? fields.workItemId : undefined;
      const attempt = Number.isInteger(fields.attempt) ? (fields.attempt as number) : undefined;
      return { action: 'run', request: { prompt: fields.prompt, round: fields.round as number, workItemId, attempt } };
    }
    case 'attach': {
      const after = fields.after ?? 0;
      if (!Number.isInteger(after) || (after as number) < 0) return 'attach takes an after of 0 or more';
      return { action: 'attach', after: after as number };
    }
    case 'status':
      return { action: 'status' };
    default:
      return 'action must be run, attach or status';
  }
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function stream(run: Run, after: number, request: http.IncomingMessage, response: http.ServerResponse): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const unsubscribe = run.subscribe(
    after,
    (entry) => response.write(`id: ${entry.seq}\ndata: ${JSON.stringify(entry.message)}\n\n`),
    () => response.end(),
  );
  // The run carries on when the caller goes away; it can attach again.
  request.on('close', unsubscribe);
}

async function readBody(request: http.IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createServer(run: Run, ping: () => Ping, onRun: (request: RunRequest) => void = () => {}): http.Server {
  return http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/ping') {
      sendJson(response, 200, ping());
      return;
    }
    if (request.method !== 'POST' || request.url !== '/invocations') {
      sendJson(response, 404, { error: 'not found' });
      return;
    }
    readBody(request).then(
      (body) => {
        const invocation = parseInvocation(body);
        if (typeof invocation === 'string') {
          sendJson(response, 400, { error: invocation });
          return;
        }
        if (invocation.action === 'status') {
          sendJson(response, 200, run.status());
          return;
        }
        if (invocation.action === 'run') {
          if (!run.start(invocation.request)) {
            sendJson(response, 409, { error: `this session has already had a run (${run.current})` });
            return;
          }
          onRun(invocation.request);
          stream(run, 0, request, response);
          return;
        }
        if (run.current === 'idle') {
          sendJson(response, 409, { error: 'no run has started in this session' });
          return;
        }
        stream(run, invocation.after, request, response);
      },
      () => sendJson(response, 400, { error: 'body must be JSON of at most 1 MiB' }),
    );
  });
}

/** Tracks /ping's status, changing time_of_last_update only when the status changes. */
export function pingTracker(now: () => number = () => Math.floor(Date.now() / 1000)): {
  ping: () => Ping;
  setBusy: (busy: boolean) => void;
} {
  // Stamped lazily: on Runtime V2 module load happens before the snapshot, so a
  // load-time stamp would be stale in every restored session.
  let current: Ping | undefined;
  const get = (): Ping => (current ??= { status: 'Healthy', time_of_last_update: now() });
  return {
    ping: get,
    setBusy: (busy) => {
      const status = busy ? 'HealthyBusy' : 'Healthy';
      if (status !== get().status) current = { status, time_of_last_update: now() };
    },
  };
}
