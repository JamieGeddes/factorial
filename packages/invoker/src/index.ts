/**
 * Harness invoker. Runs as a Fargate task started by Step Functions with
 * ecs:runTask.sync. It reads the WorkItem from the ledger, invokes one agent
 * role's harness (the planner or the builder; the role and harness come in
 * the task input) once in the prepared session, logs its progress as
 * structured lines (CloudWatch Logs; text and tool input capped at 4000
 * characters each), records the outcome, and exits. Step Functions resumes
 * when the task stops, however long the run took. Nothing inside the agent
 * sandbox can influence this process: it runs under its own task role.
 *
 * Every stream event is also buffered to disk and, however the run ends
 * (finished, failed, or the task stopped), stored with the run's usage as
 * `<stage>/transcript.jsonl` and `<stage>/usage.json` in the artefact store
 * (`plan/` for the planner, `build/` for the builder).
 */
import { readFileSync } from 'node:fs';

import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import {
  BedrockAgentCoreControlClient,
  GetHarnessCommand,
  GetHarnessEndpointCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { artefactKey, putArtefact, putJsonArtefact } from '@factorial/artefacts';
import { createLogger } from '@factorial/log';
import { assertWorkItem } from '@factorial/workitem';

import { ROLE_STAGES, harnessTarget, outcomeAttributes, promptFor } from './role.ts';
import { modelIdOf, usageRecord, type HarnessInfo } from './run-record.ts';
import { traceBaggage } from './trace.ts';
import { TranscriptBuffer } from './transcript.ts';
import { addCallUsage, emptyRunUsage, type CallUsage } from './usage.ts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const tableName = requireEnv('TABLE_NAME');
// The role and its harness arrive in the task input, so one task definition serves every role.
const { role, harnessArn, harnessId, qualifier } = harnessTarget(process.env);
const workItemId = requireEnv('WORK_ITEM_ID');
const sessionId = requireEnv('SESSION_ID');
const branch = requireEnv('BRANCH');
const baseBranch = requireEnv('BASE_BRANCH');
const baseCommit = requireEnv('BASE_COMMIT');
if (!/^[0-9a-f]{40}$/.test(baseCommit)) throw new Error('BASE_COMMIT is not a commit sha');
// Which run of the planner this is: 2 when the first plan was rejected.
const planAttempt = Number(process.env.PLAN_ATTEMPT ?? '1');
if (!Number.isInteger(planAttempt) || planAttempt < 1) throw new Error('PLAN_ATTEMPT is not a positive integer');
const { stage, running, done, failed } = ROLE_STAGES[role];

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
};
const transcript = new TranscriptBuffer('/tmp/transcript.jsonl');

/** The version `live` serves and its model. Best effort: the build goes ahead without it. */
async function harnessInfo(): Promise<HarnessInfo> {
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

/** Upload the transcript and usage under the role's stage. Returns the ledger pointer: keys and sizes, never content. */
async function storeRunRecord(): Promise<Record<string, unknown> | undefined> {
  const kept = transcript.close();
  if (!run.prefix) {
    log.error('no artefact prefix on the ledger row; run record not stored');
    return undefined;
  }
  try {
    await putArtefact(run.prefix, `${stage}/transcript.jsonl`, readFileSync(transcript.path, 'utf8'), 'application/x-ndjson');
    await putJsonArtefact(run.prefix, `${stage}/usage.json`, usageRecord({ ...run, endedAt: Date.now() }));
    log.info('run record stored', { transcriptBytes: kept.bytes, events: kept.events, truncated: kept.truncated });
    return {
      transcriptKey: artefactKey(run.prefix, `${stage}/transcript.jsonl`),
      usageKey: artefactKey(run.prefix, `${stage}/usage.json`),
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
    log.info('harness finished', { stopReason, toolCalls: run.toolCalls, durationSeconds, usage: run.usage });
    await record(
      succeeded ? done : failed,
      outcomeAttributes(role, { stopReason, toolCalls: run.toolCalls, durationSeconds, usage: run.usage, error: run.error, record: stored }),
    );
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

  const prompt = promptFor(role, workItem, branch, baseBranch, planAttempt);
  run.harness = await harnessInfo();
  log.info('invoking harness', { role, sessionId, qualifier, ...(role === 'planner' ? { planAttempt } : {}), ...run.harness });
  await record(running, { role, [`${stage}StartedAt`]: new Date().toISOString() });

  run.startedAt = Date.now();
  transcript.append({ request: { role, prompt, ...run.harness } });
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

  await finish(!run.error);
  if (run.error) return 1;
  // max_iterations or a timeout may still have produced a usable commit; the
  // Collect step decides. Only a transport or service error is fatal here.
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    run.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log.error('invoker failed', { error: run.error });
    finish(false).finally(() => process.exit(1));
  },
);
