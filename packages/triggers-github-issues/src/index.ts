/**
 * GitHub issue trigger adapter.
 *
 * Receives GitHub webhook deliveries on a Lambda function URL, verifies the
 * HMAC signature, and when the trigger label is added to an issue, places one
 * WorkItem on the Factorial event bus. Nothing downstream knows about GitHub.
 */
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { WORKITEM_DETAIL_TYPE, WORKITEM_EVENT_SOURCE } from '@factorial/workitem';

import { BadPayloadError, decideIssueEvent } from './issue-event.ts';
import { verifyGitHubSignature } from './signature.ts';

const eventBridge = new EventBridgeClient({});
const secretsManager = new SecretsManagerClient({});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

let cachedSecret: string | undefined;

async function webhookSecret(): Promise<string> {
  if (cachedSecret === undefined) {
    const response = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: requireEnv('WEBHOOK_SECRET_ARN') }),
    );
    if (response.SecretString === undefined) {
      throw new Error('Webhook secret has no string value');
    }
    cachedSecret = response.SecretString;
  }
  return cachedSecret;
}

function respond(statusCode: number, body: Record<string, unknown>): LambdaFunctionURLResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const handler = async (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> => {
  if (event.requestContext.http.method !== 'POST') {
    return respond(405, { message: 'method not allowed' });
  }

  const body = Buffer.from(event.body ?? '', event.isBase64Encoded ? 'base64' : 'utf8');
  const headers = event.headers;
  const deliveryId = headers['x-github-delivery'];

  if (!verifyGitHubSignature(await webhookSecret(), body, headers['x-hub-signature-256'])) {
    console.warn(JSON.stringify({ message: 'rejected delivery with bad signature', deliveryId }));
    return respond(401, { message: 'invalid signature' });
  }

  const githubEvent = headers['x-github-event'];
  if (githubEvent === 'ping') {
    return respond(200, { message: 'pong' });
  }
  if (githubEvent !== 'issues') {
    return respond(202, { message: `ignored event "${githubEvent ?? ''}"` });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return respond(400, { message: 'body is not valid JSON' });
  }

  let decision;
  try {
    decision = decideIssueEvent(payload, {
      triggerLabel: process.env.TRIGGER_LABEL ?? 'factorial',
      deliveryId,
    });
  } catch (error) {
    if (error instanceof BadPayloadError) {
      console.warn(JSON.stringify({ message: 'rejected malformed payload', deliveryId, error: error.message }));
      return respond(400, { message: error.message });
    }
    throw error;
  }

  if (decision.kind === 'ignore') {
    return respond(202, { message: decision.reason });
  }

  const { workItem } = decision;
  const result = await eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: requireEnv('EVENT_BUS_NAME'),
          Source: WORKITEM_EVENT_SOURCE,
          DetailType: WORKITEM_DETAIL_TYPE,
          Detail: JSON.stringify(workItem),
          Time: new Date(workItem.createdAt),
        },
      ],
    }),
  );

  if ((result.FailedEntryCount ?? 0) > 0) {
    console.error(JSON.stringify({ message: 'PutEvents failed', deliveryId, entries: result.Entries }));
    return respond(500, { message: 'failed to publish WorkItem' });
  }

  console.log(
    JSON.stringify({
      message: 'WorkItem created',
      workItemId: workItem.id,
      source: workItem.source,
      repository: workItem.repository,
    }),
  );
  return respond(202, { workItemId: workItem.id });
};
