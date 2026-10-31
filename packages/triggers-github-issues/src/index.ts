/**
 * GitHub trigger adapter.
 *
 * Receives the GitHub App's webhook deliveries on a Lambda function URL (an
 * App has one webhook URL), verifies the HMAC signature, and places at most
 * one WorkItem on the Factorial event bus: when the trigger label is added
 * to an issue, or when a trusted person or a failed run addresses one of
 * Factorial's pull requests (`pull-request-event.ts`, which records the event
 * in reply to the pull request; Intake decides what it means). When one of
 * Factorial's pull requests closes, it places a PullRequestClosed event
 * instead (#204), which records the outcome and asks nothing of Factorial.
 */
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { PULL_REQUEST_CLOSED_DETAIL_TYPE, PULL_REQUEST_CLOSED_EVENT_SOURCE } from '@factorial/pull-request-closed';
import { WORKITEM_DETAIL_TYPE, WORKITEM_EVENT_SOURCE } from '@factorial/workitem';

import { BadPayloadError, decideIssueEvent } from './issue-event.ts';
import { PULL_REQUEST_EVENTS, decidePullRequestEvent } from './pull-request-event.ts';
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

/**
 * Parse the comma-separated ALLOWED_USER_IDS. Fails closed: a missing or
 * malformed list throws rather than letting anyone trigger work.
 */
function allowedUserIds(): ReadonlySet<number> {
  const ids = requireEnv('ALLOWED_USER_IDS')
    .split(',')
    .map((id) => id.trim());
  if (ids.some((id) => !/^[0-9]+$/.test(id))) {
    throw new Error('ALLOWED_USER_IDS must be a comma-separated list of numeric GitHub user IDs');
  }
  return new Set(ids.map(Number));
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

/**
 * How a delivery ended, one line each (#59): the command centre's webhook
 * panel counts them per hour by `outcome` and `reason` in Logs Insights.
 * `work-item` and `closed` placed an event; `ignored` placed nothing by
 * design; `rejected` was refused (bad signature, method or payload);
 * `failed` could not place its event.
 */
export type DeliveryOutcome = 'work-item' | 'closed' | 'ignored' | 'rejected' | 'failed';

function delivery(outcome: DeliveryOutcome, fields: { deliveryId?: string | undefined; event?: string | undefined; reason?: string | undefined; workItemId?: string | undefined }): void {
  console.log(JSON.stringify({ message: 'delivery', outcome, ...fields }));
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
    delivery('rejected', { reason: 'method not allowed' });
    return respond(405, { message: 'method not allowed' });
  }

  const body = Buffer.from(event.body ?? '', event.isBase64Encoded ? 'base64' : 'utf8');
  const headers = event.headers;
  const deliveryId = headers['x-github-delivery'];

  if (!verifyGitHubSignature(await webhookSecret(), body, headers['x-hub-signature-256'])) {
    console.warn(JSON.stringify({ message: 'rejected delivery with bad signature', deliveryId }));
    delivery('rejected', { deliveryId, reason: 'bad signature' });
    return respond(401, { message: 'invalid signature' });
  }

  const githubEvent = headers['x-github-event'];
  if (githubEvent === 'ping') {
    delivery('ignored', { deliveryId, event: githubEvent, reason: 'ping' });
    return respond(200, { message: 'pong' });
  }
  const forPullRequest = (PULL_REQUEST_EVENTS as readonly string[]).includes(githubEvent ?? '');
  if (githubEvent !== 'issues' && !forPullRequest) {
    delivery('ignored', { deliveryId, event: githubEvent, reason: 'event not handled' });
    return respond(202, { message: `ignored event "${githubEvent ?? ''}"` });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    delivery('rejected', { deliveryId, event: githubEvent, reason: 'body is not valid JSON' });
    return respond(400, { message: 'body is not valid JSON' });
  }

  let decision;
  try {
    decision = forPullRequest
      ? decidePullRequestEvent(githubEvent!, payload, { appSlug: requireEnv('APP_SLUG'), allowedUserIds: allowedUserIds(), deliveryId })
      : decideIssueEvent(payload, {
          triggerLabel: process.env.TRIGGER_LABEL ?? 'factorial',
          allowedUserIds: allowedUserIds(),
          deliveryId,
        });
  } catch (error) {
    if (error instanceof BadPayloadError) {
      console.warn(JSON.stringify({ message: 'rejected malformed payload', deliveryId, error: error.message }));
      delivery('rejected', { deliveryId, event: githubEvent, reason: 'malformed payload' });
      return respond(400, { message: error.message });
    }
    throw error;
  }

  if (decision.kind === 'ignore') {
    // Pull request events arrive for every comment and workflow run; the
    // reason is logged so a request that did nothing can be traced.
    if (forPullRequest) console.log(JSON.stringify({ message: 'event ignored', event: githubEvent, deliveryId, reason: decision.reason }));
    delivery('ignored', { deliveryId, event: githubEvent, reason: decision.reason });
    return respond(202, { message: decision.reason });
  }

  if (decision.kind === 'closed') {
    const { closed } = decision;
    const put = await eventBridge.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: requireEnv('EVENT_BUS_NAME'),
            Source: PULL_REQUEST_CLOSED_EVENT_SOURCE,
            DetailType: PULL_REQUEST_CLOSED_DETAIL_TYPE,
            Detail: JSON.stringify(closed),
            Time: new Date(closed.closedAt),
          },
        ],
      }),
    );
    if ((put.FailedEntryCount ?? 0) > 0) {
      console.error(JSON.stringify({ message: 'PutEvents failed', deliveryId, entries: put.Entries }));
      delivery('failed', { deliveryId, event: githubEvent, reason: 'PutEvents failed' });
      return respond(500, { message: 'failed to publish PullRequestClosed' });
    }
    console.log(JSON.stringify({ message: 'pull request closed', deliveryId, repository: closed.repository, number: closed.number, merged: closed.merged }));
    delivery('closed', { deliveryId, event: githubEvent });
    return respond(202, { pullRequest: closed.number, merged: closed.merged });
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
    delivery('failed', { deliveryId, event: githubEvent, reason: 'PutEvents failed' });
    return respond(500, { message: 'failed to publish WorkItem' });
  }

  console.log(
    JSON.stringify({
      message: 'WorkItem created',
      workItemId: workItem.id,
      decision: decision.kind,
      source: workItem.source,
      repository: workItem.repository,
    }),
  );
  delivery('work-item', { deliveryId, event: githubEvent, workItemId: workItem.id });
  return respond(202, { workItemId: workItem.id });
};
