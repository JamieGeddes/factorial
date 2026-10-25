/**
 * Agent invoker. Runs as a Fargate task started by Step Functions with
 * ecs:runTask.sync. It reads the WorkItem from the ledger, invokes one agent
 * role (the builder or reviewer; the role and its target come in the
 * task input) once in the prepared session, on its harness or, with
 * TARGET=runtime, on Factorial's host on an AgentCore Runtime
 * (packages/agent-runtime), logs its progress as
 * structured lines (CloudWatch Logs; text and tool input capped at 4000
 * characters each), records the outcome, and exits. Step Functions resumes
 * when the task stops, however long the run took. A builder that stops
 * before end_turn (its iteration or time limit) exits with
 * INCOMPLETE_EXIT_CODE, so its work is saved and reported, never opened as a
 * pull request. Nothing inside the agent sandbox can influence this process:
 * it runs under its own task role.
 *
 * On a runtime, the run's SDK messages are read as server-sent events; a
 * stream that ends before the run is re-attached (runtime-stream.ts), and
 * the host's status decides how the run ended (sdk-messages.ts).
 *
 * Every stream event is also buffered to disk and, however the run ends
 * (finished, failed, or the task stopped), stored with the run's usage as
 * `<stage>/transcript.jsonl` and `<stage>/usage.json` in the artefact store
 * (`build/` for the builder, `review/` for the reviewer;
 * a build round after the first stores under `build/round-<n>/`, and the
 * ledger's `buildUsageTotal` sums the rounds).
 */
import { readFileSync } from 'node:fs';

import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import {
  BedrockAgentCoreControlClient,
  GetAgentRuntimeCommand,
  GetAgentRuntimeEndpointCommand,
  GetHarnessCommand,
  GetHarnessEndpointCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { artefactKey, putArtefact, putJsonArtefact } from '@factorial/artefacts';
import { createLogger } from '@factorial/log';
import { assertWorkItem } from '@factorial/workitem';

import { INCOMPLETE_EXIT_CODE, ROLE_STAGES, agentTarget, incompleteReason, outcomeAttributes, parseSensitivePaths, promptFor, type RuntimeTarget } from './role.ts';
import { modelIdOf, runtimeInfoOf, usageRecord, type HarnessInfo, type SdkRecord } from './run-record.ts';
import { streamRun, type InvokeSession } from './runtime-stream.ts';
import { SdkTally, runUsageOf, runtimeStop, type HostStatus } from './sdk-messages.ts';
import { traceBaggage } from './trace.ts';
import { TranscriptBuffer } from './transcript.ts';
import { addCallUsage, addRunUsage, emptyRunUsage, type CallUsage, type RunUsage } from './usage.ts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const tableName = requireEnv('TABLE_NAME');
// The role and its target arrive in the task input, so one task definition serves every role.
const target = agentTarget(process.env);
const { role, qualifier } = target;
const workItemId = requireEnv('WORK_ITEM_ID');
const sessionId = requireEnv('SESSION_ID');
const branch = requireEnv('BRANCH');
const baseBranch = requireEnv('BASE_BRANCH');
const baseCommit = requireEnv('BASE_COMMIT');
if (!/^[0-9a-f]{40}$/.test(baseCommit)) throw new Error('BASE_COMMIT is not a commit sha');
// The changes PrepareReview found to deployment and safety files, for the reviewer's prompt.
const sensitivePaths = parseSensitivePaths(process.env.SENSITIVE_PATHS);
// Which round of the build this is: 2 or more when continuing in a fresh session.
const buildRound = Number(process.env.BUILD_ROUND ?? '1');
if (!Number.isInteger(buildRound) || buildRound < 1) throw new Error('BUILD_ROUND is not a positive integer');
const { stage, running, done, failed } = ROLE_STAGES[role];
/** Where this run's records go: the stage, or a round folder under it after the first round. */
const recordPath = (name: string): string => (role === 'builder' && buildRound > 1 ? `${stage}/round-${buildRound}/${name}` : `${stage}/${name}`);

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
// The harness version's own loop timeout ends the stream; this only guards
// against a connection that never closes. The state machine's timeout for
// the stage stops the task first in any case.
const agentcore = new BedrockAgentCoreClient({ requestHandler: { requestTimeout: 4 * 60 * 60 * 1000 } });
const control = new BedrockAgentCoreControlClient({});

/** Every line carries the work item id; the attempt is added once the ledger row is read. */
let log = createLogger(stage, { workItemId });

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
  harness: {} as HarnessInfo,
  startedAt: Date.now(),
  stopReason: undefined as string | undefined,
  interrupted: false,
  toolCalls: 0,
  usage: emptyRunUsage(),
  calls: [] as CallUsage[],
  error: undefined as string | undefined,
  /** The build's usage over earlier rounds, from the ledger row, when continuing. */
  previousRoundsUsage: undefined as RunUsage | undefined,
  /** What only the Agent SDK reports, on a runtime. */
  sdk: undefined as SdkRecord | undefined,
};
const transcript = new TranscriptBuffer('/tmp/transcript.jsonl');

/** The version `live` serves and its model. Best effort: the build goes ahead without it. */
async function harnessInfo(): Promise<HarnessInfo> {
  if (target.kind === 'runtime') return runtimeInfo(target);
  const { harnessId } = target;
  try {
    const { endpoint } = await control.send(new GetHarnessEndpointCommand({ harnessId, endpointName: qualifier }));
    const harnessVersion = endpoint?.liveVersion ?? endpoint?.targetVersion;
    const { harness } = await control.send(new GetHarnessCommand({ harnessId, ...(harnessVersion ? { harnessVersion } : {}) }));
    const modelId = modelIdOf(harness?.model);
    return {
      ...(harness?.harnessName ? { harnessName: harness.harnessName } : {}),
      ...(harnessVersion ? { harnessVersion } : {}),
      ...(modelId ? { modelId } : {}),
      ...(harness?.maxIterations === undefined ? {} : { maxIterations: harness.maxIterations }),
      ...(harness?.timeoutSeconds === undefined ? {} : { timeoutSeconds: harness.timeoutSeconds }),
    };
  } catch (error) {
    log.error('harness version unknown', { error });
    return {};
  }
}

/** The runtime version `live` serves, its model and limits. Best effort, like harnessInfo. */
async function runtimeInfo({ runtimeId }: RuntimeTarget): Promise<HarnessInfo> {
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

/** Upload the transcript and usage under the role's stage. Returns the ledger pointer: keys and sizes, never content. */
async function storeRunRecord(): Promise<Record<string, unknown> | undefined> {
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
      transcriptBytes: kept.bytes,
      transcriptTruncated: kept.truncated,
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
    log.info('agent finished', { target: target.kind, stopReason, toolCalls: run.toolCalls, durationSeconds, usage: run.usage, costUsd: run.sdk?.costUsd });
    const outcome = outcomeAttributes(role, { stopReason, toolCalls: run.toolCalls, durationSeconds, usage: run.usage, error: run.error, record: stored });
    // The builder's figures are this round's; the total across rounds is kept beside them.
    const rounds = role === 'builder' ? { buildRounds: buildRound, buildUsageTotal: run.previousRoundsUsage ? addRunUsage(run.previousRoundsUsage, run.usage) : run.usage } : {};
    await record(succeeded ? done : failed, { ...outcome, ...rounds });
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
  if (role === 'builder' && buildRound > 1) {
    const previous = row.Item?.buildUsageTotal ?? row.Item?.usage;
    run.previousRoundsUsage = previous && typeof previous === 'object' ? addRunUsage(emptyRunUsage(), previous as RunUsage) : undefined;
  }

  const resumed = typeof row.Item?.resumedFrom === 'string';
  const prompt = promptFor(role, workItem, branch, baseBranch, { sensitivePaths, buildRound, resumed });
  run.harness = await harnessInfo();
  log.info('invoking agent', { role, target: target.kind, sessionId, qualifier, ...(role === 'builder' ? { buildRound } : {}), ...run.harness });
  await record(running, { role, [`${stage}StartedAt`]: new Date().toISOString() });

  run.startedAt = Date.now();
  transcript.append({ request: { role, prompt, ...run.harness } });
  if (target.kind === 'runtime') {
    await invokeRuntime(target, prompt);
  } else {
    await invokeHarness(target.harnessArn, prompt);
  }

  // A builder that hit its iteration or time limit has not finished the
  // plan: fail the task so its work is saved and reported, not tested and
  // opened as a pull request.
  const incomplete = run.error ? undefined : incompleteReason(role, run.stopReason);
  if (incomplete) run.error = incomplete;
  await finish(!run.error);
  if (incomplete) return INCOMPLETE_EXIT_CODE;
  return run.error ? 1 : 0;
}

async function invokeHarness(harnessArn: string, prompt: string): Promise<void> {
  const response = await agentcore.send(
    new InvokeHarnessCommand({
      harnessArn,
      qualifier,
      runtimeSessionId: sessionId,
      baggage: traceBaggage(sessionId, workItemId, run.attempt),
      // No maxIterations or timeoutSeconds: values passed here override the
      // harness version's, and the limits, like the model, belong to the version.
      messages: [{ role: 'user', content: [{ text: prompt }] }],
    }),
  );

  let text = '';
  let toolInput = '';
  for await (const event of response.stream ?? []) {
    transcript.append(event);
    if (event.messageStart) {
      log.info('message start', { role: event.messageStart.role });
    } else if (event.contentBlockStart?.start?.toolUse) {
      run.toolCalls += 1;
      log.info('tool use', { tool: event.contentBlockStart.start.toolUse.name });
    } else if (event.contentBlockDelta?.delta?.text) {
      text += event.contentBlockDelta.delta.text;
    } else if (event.contentBlockDelta?.delta?.toolUse?.input) {
      // Tool input arrives in deltas; log it whole when the block ends.
      toolInput += event.contentBlockDelta.delta.toolUse.input;
    } else if (event.contentBlockStop) {
      if (text.trim()) {
        log.info('assistant text', { text: text.slice(-4000) });
        text = '';
      }
      if (toolInput) {
        log.info('tool input', { input: toolInput.slice(0, 4000), bytes: Buffer.byteLength(toolInput) });
        toolInput = '';
      }
    } else if (event.messageStop) {
      run.stopReason = event.messageStop.stopReason;
      log.info('message stop', { stopReason: run.stopReason });
    } else if (event.metadata) {
      // One usage record arrives per model call; the run's consumption is their sum.
      const call = event.metadata.usage as CallUsage | undefined;
      run.usage = addCallUsage(run.usage, call);
      if (call) run.calls.push(call);
    } else if (event.internalServerException || event.validationException || event.runtimeClientError) {
      const error = event.internalServerException ?? event.validationException ?? event.runtimeClientError;
      run.error = `${error?.name ?? 'StreamError'}: ${error?.message ?? ''}`;
      log.error('stream error', { error: run.error });
    }
  }
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

  const tally = new SdkTally();
  const reconnects = await streamRun(
    invoke,
    { action: 'run', prompt, round: buildRound, workItemId, attempt: run.attempt },
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
  // messages are the fallback.
  let status: HostStatus | undefined;
  try {
    const response = await send({ action: 'status' }, 'application/json');
    status = JSON.parse((await response.response?.transformToString()) ?? '{}') as HostStatus;
  } catch (error) {
    log.error('run status unknown', { error });
  }

  run.usage = runUsageOf(tally);
  const stop = runtimeStop(tally, status);
  run.stopReason = stop.stopReason;
  if (stop.error) {
    run.error = stop.error;
    log.error('run failed', { error: run.error });
  }
  run.sdk = {
    ...(tally.result ? { resultSubtype: tally.result.subtype } : {}),
    ...(tally.result?.numTurns === undefined ? {} : { numTurns: tally.result.numTurns }),
    ...(tally.result?.costUsd === undefined ? {} : { costUsd: tally.result.costUsd }),
    ...(tally.result?.modelUsage ? { modelUsage: tally.result.modelUsage } : {}),
    permissionDenials: tally.result?.permissionDenials ?? 0,
    reconnects,
  };
  log.info('runtime run ended', { stopReason: run.stopReason, status: status?.state, outcome: status?.outcome, ...run.sdk, modelUsage: undefined });
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    run.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log.error('invoker failed', { error: run.error });
    finish(false).finally(() => process.exit(1));
  },
);
