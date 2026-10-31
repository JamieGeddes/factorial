/**
 * Agent invoker. Runs as a Fargate task started by Step Functions with
 * ecs:runTask.sync. It reads the WorkItem from the ledger, invokes one agent
 * role (the builder or reviewer; the role and its Runtime come in the task
 * input) once in the prepared session, on Factorial's host on the role's
 * AgentCore Runtime (packages/agent-runtime), logs its progress as
 * structured lines (CloudWatch Logs; text and tool input capped at 4000
 * characters each), records the outcome, and exits. Step Functions resumes
 * when the task stops, however long the run took. A run of a role that must
 * finish (the builder) that stops before it succeeds (its turn, budget or
 * time limit) exits with INCOMPLETE_EXIT_CODE, so its work is saved and reported, never opened as a
 * pull request. Nothing inside the agent sandbox can influence this process:
 * it runs under its own task role.
 *
 * The run's events (contracts/run/v1/) are read as server-sent events; a
 * stream that ends before the run is re-attached (runtime-stream.ts), and the
 * streamed run.ended, checked against the host's status, decides how the run
 * ended (run-events.ts). Nothing here reads the harness's own messages, so the
 * harness and the model's provider can change on the Runtime alone. The run
 * contract the version serving `live` declares is checked before invoking.
 *
 * Every stream event is also buffered to disk and, however the run ends
 * (finished, failed, or the task stopped), stored with the run's usage as
 * `<stage>/transcript.jsonl` and `<stage>/usage.json` in the artefact store
 * (`build/` for the builder, `review/` for the reviewer; for a role that
 * works in rounds, a round after the first stores under
 * `<stage>/round-<n>/`, and the ledger's `<stage>UsageTotal` sums the
 * rounds). The stage, statuses and first message come from the role's
 * manifest (@factorial/roles).
 */
import { readFileSync } from 'node:fs';

import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { BedrockAgentCoreControlClient, GetAgentRuntimeCommand, GetAgentRuntimeEndpointCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { artefactKey, putArtefact, putJsonArtefact } from '@factorial/artefacts';
import { createLogger } from '@factorial/log';
import { isStageName, progressRecorder, stageError } from '@factorial/progress';
import { ROLES } from '@factorial/roles';
import { RUN_CONTRACT, RUN_CONTRACT_VARIABLE, validateRunStatus, type RunOutcome, type RunStatus } from '@factorial/run';
import { assertWorkItem } from '@factorial/workitem';

import { INCOMPLETE_EXIT_CODE, incompleteReason, parseSensitivePaths, runtimeTarget, type RuntimeTarget } from './role.ts';
import { roundUsd, runEntryOf, runtimeInfoOf, usageRecord, type HarnessRecord, type VersionInfo } from './run-record.ts';
import { streamRun, type InvokeSession } from './runtime-stream.ts';
import { RunTally, runUsageOf, runtimeStop, subagentsOf } from './run-events.ts';
import { traceBaggage } from './trace.ts';
import { TranscriptBuffer } from './transcript.ts';
import { addCallUsage, addRunUsage, emptyRunUsage, previousRoundsUsage, type CallUsage, type RunUsage } from './usage.ts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const tableName = requireEnv('TABLE_NAME');
// The role and its target arrive in the task input, so one task definition serves every role.
const target = runtimeTarget(process.env);
const { role, qualifier } = target;
const manifest = ROLES[role];
const workItemId = requireEnv('WORK_ITEM_ID');
const sessionId = requireEnv('SESSION_ID');
const branch = requireEnv('BRANCH');
const baseBranch = requireEnv('BASE_BRANCH');
const baseCommit = requireEnv('BASE_COMMIT');
if (!/^[0-9a-f]{40}$/.test(baseCommit)) throw new Error('BASE_COMMIT is not a commit sha');
// The changes PrepareReview found to deployment and safety files, for the reviewer's prompt.
const sensitivePaths = parseSensitivePaths(process.env.SENSITIVE_PATHS);
// Which round this is, for a role that works in rounds: 2 or more when continuing in a fresh session.
const buildRound = Number(process.env.BUILD_ROUND ?? '1');
if (!Number.isInteger(buildRound) || buildRound < 1) throw new Error('BUILD_ROUND is not a positive integer');
const round = manifest.rounds ? buildRound : undefined;
const { stage } = manifest;
const { running, done, failed } = manifest.statuses;
// The state's name, for the progress record (#15); an execution started before #15 passes none, and records nothing.
const progressStage = isStageName(process.env.STAGE) ? process.env.STAGE : undefined;
/** Where this run's records go: the stage, or a round folder under it after the first round. */
const recordPath = (name: string): string => (round !== undefined && round > 1 ? `${stage}/round-${round}/${name}` : `${stage}/${name}`);

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
// The host's own time limit ends the run; this only guards against a
// connection that never closes. The state machine's timeout for the stage
// stops the task first in any case.
const agentcore = new BedrockAgentCoreClient({ requestHandler: { requestTimeout: 4 * 60 * 60 * 1000 } });
const control = new BedrockAgentCoreControlClient({});

/** Every line carries the work item id; the attempt is added once the ledger row is read. */
let log = createLogger(stage, { workItemId });
// Best effort: a progress write that fails is logged and the run goes on.
const progress = progressRecorder(process.env, { onError: (message, fields) => log.error(message, fields) });

async function record(status: string, attributes: Record<string, unknown>): Promise<void> {
  const names: Record<string, string> = { '#status': 'status', '#updatedAt': 'updatedAt' };
  const values: Record<string, unknown> = { ':status': status, ':updatedAt': new Date().toISOString() };
  const sets = ['#status = :status', '#updatedAt = :updatedAt'];
  let i = 0;
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    i += 1;
    names[`#a${i}`] = key;
    values[`:a${i}`] = value;
    sets.push(`#a${i} = :a${i}`);
  }
  await documents.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { workItemId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

/** The run so far, shared with the stop handler so an interrupted build still records it. */
const run = {
  prefix: undefined as string | undefined,
  attempt: undefined as number | undefined,
  version: {} as VersionInfo,
  startedAt: Date.now(),
  stopReason: undefined as string | undefined,
  outcome: undefined as RunOutcome | undefined,
  interrupted: false,
  toolCalls: 0,
  usage: emptyRunUsage(),
  calls: [] as CallUsage[],
  error: undefined as string | undefined,
  /** The build's usage over earlier rounds, from the ledger row, when continuing. */
  previousRoundsUsage: undefined as RunUsage | undefined,
  /** What the harness reports beyond the counts. */
  harness: undefined as HarnessRecord | undefined,
};
const transcript = new TranscriptBuffer('/tmp/transcript.jsonl');

/** The runtime version `live` serves, its model and limits. Best effort: the run goes ahead without it. */
async function runtimeInfo({ runtimeId }: RuntimeTarget): Promise<VersionInfo> {
  try {
    const endpoint = await control.send(new GetAgentRuntimeEndpointCommand({ agentRuntimeId: runtimeId, endpointName: qualifier }));
    const runtimeVersion = endpoint.liveVersion ?? endpoint.targetVersion;
    const runtime = await control.send(
      new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId, ...(runtimeVersion ? { agentRuntimeVersion: runtimeVersion } : {}) }),
    );
    return {
      ...(runtime.agentRuntimeName ? { runtimeName: runtime.agentRuntimeName } : {}),
      ...(runtimeVersion ? { runtimeVersion } : {}),
      ...runtimeInfoOf(runtime.environmentVariables),
    };
  } catch (error) {
    log.error('runtime version unknown', { error });
    return {};
  }
}

/** Upload the transcript and usage under the role's stage. Returns their keys for the stage's entry, never content. */
async function storeRunRecord(): Promise<{ transcriptKey: string; usageKey: string } | undefined> {
  const kept = transcript.close();
  if (!run.prefix) {
    log.error('no artefact prefix on the ledger row; run record not stored');
    return undefined;
  }
  try {
    await putArtefact(run.prefix, recordPath('transcript.jsonl'), readFileSync(transcript.path, 'utf8'), 'application/x-ndjson');
    await putJsonArtefact(run.prefix, recordPath('usage.json'), usageRecord({ ...run, endedAt: Date.now() }));
    log.info('run record stored', { transcriptBytes: kept.bytes, events: kept.events, truncated: kept.truncated });
    return {
      transcriptKey: artefactKey(run.prefix, recordPath('transcript.jsonl')),
      usageKey: artefactKey(run.prefix, recordPath('usage.json')),
    };
  } catch (error) {
    log.error('run record not stored', { error });
    return undefined;
  }
}

let finished: Promise<void> | undefined;

/** Store the run record and the outcome exactly once, whichever way the run ends. */
function finish(succeeded: boolean): Promise<void> {
  finished ??= (async () => {
    const stored = await storeRunRecord();
    const durationSeconds = Math.round((Date.now() - run.startedAt) / 1000);
    const stopReason = run.interrupted ? 'interrupted' : run.stopReason;
    log.info('agent finished', { stopReason, toolCalls: run.toolCalls, durationSeconds, usage: run.usage, costUsd: run.harness?.costUsd });
    // The run itself is recorded on its stage's entry below; a role in rounds also keeps the total across rounds.
    const total = round !== undefined ? { [`${stage}UsageTotal`]: run.previousRoundsUsage ? addRunUsage(run.previousRoundsUsage, run.usage) : run.usage } : {};
    await record(succeeded ? done : failed, total);
    if (progressStage) {
      const entry = runEntryOf({
        role,
        sessionId,
        version: run.version,
        harness: run.harness,
        stopReason,
        outcome: run.outcome,
        toolCalls: run.toolCalls,
        durationSeconds,
        usage: run.usage,
        record: stored,
      });
      const error = run.error ? stageError(stopReason ?? 'error', run.error) : undefined;
      await progress.ended(workItemId, progressStage, buildRound, succeeded ? 'succeeded' : 'failed', { run: entry, ...(error ? { error } : {}) });
    }
  })();
  return finished;
}

// ECS stops the task (a Step Functions timeout, or by hand) with SIGTERM,
// then SIGKILL after the container's stop timeout. Record what there is.
process.once('SIGTERM', () => {
  run.interrupted = true;
  run.error ??= 'interrupted';
  log.error('invoker interrupted');
  void finish(false).finally(() => process.exit(1));
});

async function main(): Promise<number> {
  const row = await documents.send(new GetCommand({ TableName: tableName, Key: { workItemId } }));
  const workItem: unknown = row.Item?.workItem;
  assertWorkItem(workItem);
  run.prefix = typeof row.Item?.artefactPrefix === 'string' ? row.Item.artefactPrefix : undefined;
  run.attempt = typeof row.Item?.attempt === 'number' ? row.Item.attempt : undefined;
  log = log.with({ attempt: run.attempt });
  run.previousRoundsUsage = previousRoundsUsage(row.Item, stage, round);

  const resumed = typeof row.Item?.resumedFrom === 'string';
  const prompt = manifest.firstMessage(workItem, branch, baseBranch, { sensitivePaths, ...(round !== undefined ? { round } : {}), resumed });
  run.version = await runtimeInfo(target);
  // A version from either side of a run contract change fails here, before
  // the session starts a run. When the version could not be read, the host's
  // own check on the request and the first event's still apply.
  if (run.version.runtimeName !== undefined && run.version.runContract !== RUN_CONTRACT) {
    throw new Error(
      `the Runtime version serving ${qualifier} declares run contract ${run.version.runContract ?? 'none'} (${RUN_CONTRACT_VARIABLE}); this invoker reads ${RUN_CONTRACT}`,
    );
  }
  log.info('invoking agent', { role, sessionId, qualifier, ...(round !== undefined ? { buildRound: round } : {}), ...run.version });
  await record(running, {});
  if (progressStage) await progress.started(workItemId, progressStage, buildRound);

  run.startedAt = Date.now();
  transcript.append({ request: { role, prompt, ...run.version } });
  await invokeRuntime(target, prompt);

  // A builder that hit its turn, budget or time limit has not finished the
  // plan: fail the task so its work is saved and reported, not tested and
  // opened as a pull request.
  const incomplete = run.error ? undefined : incompleteReason(manifest, run.outcome, run.stopReason);
  if (incomplete) run.error = incomplete;
  await finish(!run.error);
  if (incomplete) return INCOMPLETE_EXIT_CODE;
  return run.error ? 1 : 0;
}

/** The JSON a runtime invocation sends; the model, limits and tools are the version's, never the request's. */
function runtimePayload(payload: object): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

async function invokeRuntime(runtime: RuntimeTarget, prompt: string): Promise<void> {
  const baggage = traceBaggage(sessionId, workItemId, run.attempt);
  const send = (payload: object, accept: string) =>
    agentcore.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: runtime.runtimeArn,
        qualifier: runtime.qualifier,
        runtimeSessionId: sessionId,
        baggage,
        contentType: 'application/json',
        accept,
        payload: runtimePayload(payload),
      }),
    );
  const invoke: InvokeSession = async (payload) => {
    const response = await send(payload, 'text/event-stream');
    if (!response.response) throw new Error('the runtime returned no body');
    return response.response as AsyncIterable<Uint8Array>;
  };

  const tally = new RunTally();
  const reconnects = await streamRun(
    invoke,
    { action: 'run', contract: RUN_CONTRACT, prompt, round: buildRound, workItemId, attempt: run.attempt },
    (message) => {
      if (typeof message === 'object' && message !== null) transcript.append(message);
      for (const line of tally.add(message)) log.info(line.message, line.fields);
      // Kept current, so a stopped task still records what was used.
      run.toolCalls = tally.toolCalls;
      run.calls = tally.calls;
      run.usage = tally.calls.reduce(addCallUsage, emptyRunUsage());
    },
    () => tally.ended,
    {
      maxReconnects: 20,
      delayMs: 5000,
      onReconnect: (attempt, after, reason) => log.info('re-attaching to the run', { attempt, after, reason }),
    },
  );

  // The host's own record of how the run ended. Best effort: the streamed
  // events are the fallback.
  let status: RunStatus | undefined;
  try {
    const response = await send({ action: 'status' }, 'application/json');
    const parsed = validateRunStatus(JSON.parse((await response.response?.transformToString()) ?? '{}'));
    if (parsed.ok) status = parsed.value;
    else log.error('run status does not meet the run contract', { errors: parsed.errors.slice(0, 5) });
  } catch (error) {
    log.error('run status unknown', { error });
  }

  run.usage = runUsageOf(tally);
  const stop = runtimeStop(tally, status);
  run.stopReason = stop.stopReason;
  run.outcome = stop.outcome;
  if (stop.error) {
    run.error = stop.error;
    log.error('run failed', { error: run.error });
  }
  const { started, end } = tally;
  run.harness = {
    ...(started?.harness.name ? { name: started.harness.name } : {}),
    ...(started?.harness.version ? { version: started.harness.version } : {}),
    ...(started ? { configuredModels: started.models } : {}),
    ...(end?.detail ? { detail: end.detail } : {}),
    ...(end?.turns === undefined ? {} : { turns: end.turns }),
    ...(end?.cost ? { costUsd: roundUsd(end.cost.usd) } : {}),
    ...(end?.models ? { models: end.models.map((m) => (m.costUsd === undefined ? m : { ...m, costUsd: roundUsd(m.costUsd) })) } : {}),
    deniedToolCalls: end?.deniedToolCalls ?? 0,
    reconnects,
    ...(tally.invalidEvents > 0 ? { invalidEvents: tally.invalidEvents } : {}),
    ...(tally.subagentRuns.length > 0 ? { subagents: subagentsOf(tally.subagentRuns) } : {}),
  };
  log.info('runtime run ended', {
    stopReason: run.stopReason,
    outcome: run.outcome,
    status: status?.state,
    ...run.harness,
    configuredModels: undefined,
    models: undefined,
    subagents: undefined,
  });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    run.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log.error('invoker failed', { error: run.error });
    finish(false).finally(() => process.exit(1));
  },
);
