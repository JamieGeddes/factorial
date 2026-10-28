/**
 * Entry point: reads the Runtime version's configuration, then serves the
 * Runtime contract on port 8080 and runs the role once when asked, on the
 * harness (claude-sdk/harness.ts), streamed as run events (contracts/run/v1/).
 */
import { createLogger } from '@factorial/log';

import { claudeHarness } from './claude-sdk/harness.ts';
import { readConfig } from './config.ts';
import { HOST_ROLES } from './roles.ts';
import { Run, type RunRequest } from './run.ts';
import { createServer, pingTracker } from './server.ts';

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

const harness = claudeHarness(config, HOST_ROLES[config.role], abortController);
const { started } = harness;

function startRun(request: RunRequest) {
  log = log.with({ workItemId: request.workItemId, attempt: request.attempt });
  return harness.start(request, (message, fields) => log.info(message, fields));
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
