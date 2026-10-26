/**
 * Entry point: reads the Runtime version's configuration, then serves the
 * Runtime contract on port 8080 and runs one SDK query when asked.
 */
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from '@factorial/log';

import { readConfig } from './config.ts';
import { preToolUseHooks, reviewerPreToolUseHooks } from './hooks.ts';
import { queryOptions } from './options.ts';
import { planBrief, planHooks, readAgentFile, stopHooks, type PlanGate } from './report.ts';
import { reviewStopHooks } from './review.ts';
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

const onDenied = (toolName: string, reason: string) => log.info('tool use denied', { toolName, reason });

function startBuilder(request: RunRequest): AsyncIterable<unknown> {
  const planGate: PlanGate = { closed: false };
  const options = queryOptions(config, {
    hostEnv: process.env,
    preToolUse: preToolUseHooks(config.workspace, onDenied, () => planGate.closed),
    postToolUse: planHooks(config.workspace, planGate, (errors, closed) => log.info(closed ? 'plan invalid again; tools closed' : 'plan invalid; builder sent back', { errors })),
    stop: stopHooks(config.workspace, planGate, (reason) => log.info('report incomplete; builder sent back', { reason })),
    webSearch: config.webSearchGatewayUrl
      ? webSearchServer(signedGatewayCall(config.webSearchGatewayUrl, config.region))
      : undefined,
    abortController,
    stderr: (data) => log.info('sdk stderr', { data: data.slice(0, 2000) }),
  });
  const brief = planBrief(readAgentFile(path.join(config.workspace, 'plan.json')));
  return query({ prompt: brief ? `${request.prompt}\n\n${brief}` : request.prompt, options });
}

function startReviewer(request: RunRequest): AsyncIterable<unknown> {
  const options = queryOptions(config, {
    hostEnv: process.env,
    preToolUse: reviewerPreToolUseHooks(config.workspace, onDenied),
    postToolUse: [],
    stop: reviewStopHooks(config.workspace, (reason) => log.info('review missing or invalid; reviewer sent back', { reason })),
    webSearch: undefined,
    abortController,
    stderr: (data) => log.info('sdk stderr', { data: data.slice(0, 2000) }),
  });
  return query({ prompt: request.prompt, options });
}

function startQuery(request: RunRequest): AsyncIterable<unknown> {
  log = log.with({ workItemId: request.workItemId, attempt: request.attempt });
  return config.role === 'reviewer' ? startReviewer(request) : startBuilder(request);
}

const limits = { maxDurationMs: config.maxDurationSeconds * 1000, abort: () => abortController.abort() };
const run = new Run(config.stateDirectory, startQuery, (state) => {
  setBusy(state === 'running');
  if (state === 'running') return;
  const { messages, outcome, stopReason, error } = run.status();
  log.info('run ended', { state, messages, outcome, stopReason, error });
}, limits);

const server = createServer(run, ping, (request) =>
  log.info('run started', { role: config.role, model: config.model, round: request.round }),
);
server.listen(config.port, '0.0.0.0', () => log.info('listening', { port: config.port, role: config.role, model: config.model }));

process.on('SIGTERM', () => {
  log.info('SIGTERM; stopping the run');
  abortController.abort();
  server.close();
});
