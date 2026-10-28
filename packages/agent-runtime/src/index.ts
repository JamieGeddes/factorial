/**
 * Entry point: reads the Runtime version's configuration, then serves the
 * Runtime contract on port 8080 and runs one SDK query when asked, streamed
 * as run events (contracts/run/v1/, claude-sdk-events.ts).
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '@factorial/log';

import { claudeRunEvents, runStarted } from './claude-sdk-events.ts';
import { readConfig } from './config.ts';
import { queryOptions } from './options.ts';
import { HOST_ROLES } from './roles.ts';
import { Run, type RunRequest } from './run.ts';
import { createServer, pingTracker } from './server.ts';
import { signedGatewayCall, webSearchServer } from './web-search.ts';

const config = readConfig(process.env);
// The host must be root so the agent user, which the SDK subprocess drops to,
// can neither signal nor trace it, nor change the run's record.
if (process.getuid?.() !== 0) throw new Error('the host process must run as root; see agent-runtime/Dockerfile');
// As root, the host must read no configuration from a directory the agent user can write.
for (const [name, value] of [['HOME', process.env.HOME], ['cwd', process.cwd()]]) {
  if (!value || value.startsWith(config.workspace) || value.startsWith(config.agentHome)) {
    throw new Error(`the host's ${name} (${value}) must be root-owned, outside ${config.workspace} and ${config.agentHome}`);
  }
}
let log = createLogger('agent-runtime');
const abortController = new AbortController();
const { ping, setBusy } = pingTracker();

const role = HOST_ROLES[config.role];
const started = runStarted(config, role.tools);

function startRun(request: RunRequest): ReturnType<typeof claudeRunEvents> {
  log = log.with({ workItemId: request.workItemId, attempt: request.attempt });
  const session = role.session(config.workspace, (message, fields) => log.info(message, fields));
  const options = queryOptions(config, role, {
    hostEnv: process.env,
    preToolUse: session.preToolUse,
    postToolUse: session.postToolUse,
    stop: session.stop,
    webSearch:
      role.webSearch && config.webSearchGatewayUrl ? webSearchServer(signedGatewayCall(config.webSearchGatewayUrl, config.region)) : undefined,
    abortController,
    stderr: (data) => log.info('sdk stderr', { data: data.slice(0, 2000) }),
  });
  return claudeRunEvents(started, query({ prompt: session.prompt(request.prompt), options }));
}

const limits = { maxDurationMs: config.maxDurationSeconds * 1000, abort: () => abortController.abort() };
const run = new Run(config.stateDirectory, startRun, (state) => {
  setBusy(state === 'running');
  if (state === 'running') return;
  const { events, ended } = run.status();
  log.info('run ended', { state, events, outcome: ended?.outcome, reason: ended?.reason, detail: ended?.detail, errors: ended?.errors });
}, limits);

const server = createServer(run, ping, (request) =>
  log.info('run started', { role: config.role, model: config.model, harness: started.harness, round: request.round }),
);
server.listen(config.port, '0.0.0.0', () => log.info('listening', { port: config.port, role: config.role, model: config.model }));

process.on('SIGTERM', () => {
  log.info('SIGTERM; stopping the run');
  abortController.abort();
  server.close();
});
