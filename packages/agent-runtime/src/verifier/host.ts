/**
 * The verifier Runtime's host (#167). A verifier session runs a target's
 * declared checks through the session command API (verifier/command.ts), so
 * its host runs no model and no run: it answers the Runtime contract's health
 * check and refuses every invocation. The Runtime's execution role names no
 * model either, so an invocation could do nothing if it were served.
 *
 * /ping reports HealthyBusy while a check runs, which keeps the session past
 * its idle timeout: the command writes a marker as it starts and removes it as
 * it ends (BUSY_MARKER), in a root-only directory the check cannot touch.
 */
import { existsSync } from 'node:fs';
import http from 'node:http';

import { createLogger } from '@factorial/log';

import { pingTracker, type Ping } from '../server.ts';

/** Present while a check runs. Under /var/lib/factorial, root-only (agent-runtime/Dockerfile). */
export const BUSY_MARKER = '/var/lib/factorial/verifier-busy';

const WORKSPACE = '/workspace';
const AGENT_HOME = '/home/agent';

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** The health check and nothing else. */
export function createVerifierServer(ping: () => Ping): http.Server {
  return http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/ping') {
      sendJson(response, 200, ping());
      return;
    }
    if (request.method === 'POST' && request.url === '/invocations') {
      // Drain the body so the connection closes cleanly.
      request.resume();
      sendJson(response, 403, { error: 'the verifier Runtime runs no model: its sessions take session commands only' });
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  });
}

/** /ping's status from the marker, read on every check. */
export function verifierPing(busy: () => boolean, tracker = pingTracker()): () => Ping {
  return () => {
    tracker.setBusy(busy());
    return tracker.ping();
  };
}

/** Serve the verifier Runtime's contract on port 8080. Called by index.ts on the verifier Runtime. */
export function serveVerifier(): void {
  // As the agent host: root, so the check's user can neither signal nor trace
  // it, and reading no configuration from a directory that user can write.
  if (process.getuid?.() !== 0) throw new Error('the host process must run as root; see agent-runtime/Dockerfile');
  for (const [name, value] of [['HOME', process.env.HOME], ['cwd', process.cwd()]]) {
    if (!value || value.startsWith(WORKSPACE) || value.startsWith(AGENT_HOME)) {
      throw new Error(`the host's ${name} (${value}) must be root-owned, outside ${WORKSPACE} and ${AGENT_HOME}`);
    }
  }
  const log = createLogger('verifier-host');
  const server = createVerifierServer(verifierPing(() => existsSync(BUSY_MARKER)));
  server.listen(8080, '0.0.0.0', () => log.info('listening', { port: 8080, runtime: 'verifier' }));
  process.on('SIGTERM', () => server.close());
}
