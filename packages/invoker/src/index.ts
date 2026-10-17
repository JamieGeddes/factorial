/**
 * Harness invoker. Runs as a Fargate task started by Step Functions with
 * ecs:runTask.sync. It reads the WorkItem from the ledger, invokes the builder
 * harness once in the prepared session, streams the transcript to stdout
 * (CloudWatch Logs), records the outcome, and exits. Step Functions resumes
 * when the task stops, however long the build took. Nothing inside the agent
 * sandbox can influence this process: it runs under its own task role.
 */
import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { assertWorkItem } from '@factorial/workitem';

import { buildPrompt } from './prompt.ts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const tableName = requireEnv('TABLE_NAME');
const harnessArn = requireEnv('HARNESS_ARN');
const qualifier = requireEnv('HARNESS_QUALIFIER');
const workItemId = requireEnv('WORK_ITEM_ID');
const sessionId = requireEnv('SESSION_ID');
const branch = requireEnv('BRANCH');
const baseBranch = requireEnv('BASE_BRANCH');
const maxIterations = Number(process.env.MAX_ITERATIONS ?? '150');
const timeoutSeconds = Number(process.env.TIMEOUT_SECONDS ?? '3600');

const documents = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const agentcore = new BedrockAgentCoreClient({ requestHandler: { requestTimeout: (timeoutSeconds + 300) * 1000 } });

function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ workItemId, ...entry }));
}

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

async function main(): Promise<number> {
  const row = await documents.send(new GetCommand({ TableName: tableName, Key: { workItemId } }));
  const workItem: unknown = row.Item?.workItem;
  assertWorkItem(workItem);

  const prompt = buildPrompt(workItem, branch, baseBranch);
  log({ message: 'invoking harness', sessionId, qualifier, maxIterations, timeoutSeconds });
  await record('building', { buildStartedAt: new Date().toISOString() });

  const started = Date.now();
  const response = await agentcore.send(
    new InvokeHarnessCommand({
      harnessArn,
      qualifier,
      runtimeSessionId: sessionId,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      maxIterations,
      timeoutSeconds,
    }),
  );

  let stopReason: string | undefined;
  let usage: Record<string, number | undefined> | undefined;
  let toolCalls = 0;
  let text = '';
  let streamError: string | undefined;

  for await (const event of response.stream ?? []) {
    if (event.messageStart) {
      log({ message: 'message start', role: event.messageStart.role });
    } else if (event.contentBlockStart?.start?.toolUse) {
      toolCalls += 1;
      log({ message: 'tool use', tool: event.contentBlockStart.start.toolUse.name });
    } else if (event.contentBlockDelta?.delta?.text) {
      text += event.contentBlockDelta.delta.text;
    } else if (event.contentBlockDelta?.delta?.toolUse?.input) {
      // Tool input arrives in deltas; surface it for the transcript.
      process.stdout.write(event.contentBlockDelta.delta.toolUse.input);
    } else if (event.contentBlockStop) {
      if (text.trim()) {
        log({ message: 'assistant text', text: text.slice(-4000) });
        text = '';
      }
    } else if (event.messageStop) {
      stopReason = event.messageStop.stopReason;
      log({ message: 'message stop', stopReason });
    } else if (event.metadata) {
      usage = event.metadata.usage as Record<string, number | undefined> | undefined;
    } else if (event.internalServerException || event.validationException || event.runtimeClientError) {
      const error = event.internalServerException ?? event.validationException ?? event.runtimeClientError;
      streamError = `${error?.name ?? 'StreamError'}: ${error?.message ?? ''}`;
      log({ message: 'stream error', error: streamError });
    }
  }

  const durationSeconds = Math.round((Date.now() - started) / 1000);
  log({ message: 'harness finished', stopReason, toolCalls, durationSeconds, usage });
  await record(streamError ? 'build-error' : 'built', {
    stopReason,
    toolCalls,
    buildDurationSeconds: durationSeconds,
    usage,
    buildError: streamError,
  });

  if (streamError) return 1;
  // max_iterations or a timeout may still have produced a usable commit; the
  // Collect step decides. Only a transport or service error is fatal here.
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    log({ message: 'invoker failed', error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    record('build-error', { buildError: error instanceof Error ? error.message : String(error) }).finally(() => process.exit(1));
  },
);
