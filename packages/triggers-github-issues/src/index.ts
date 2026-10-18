/**
 * GitHub trigger adapter: issue events and events on Factorial's own pull
 * requests both become WorkItems on the Factorial bus. Receives GitHub webhook
 * deliveries on a Lambda function URL, verifies the HMAC signature, and routes
 * each delivery to the matching decision function. Nothing downstream knows about GitHub.
 *
 * Receives GitHub webhook deliveries on a Lambda function URL, verifies the
 * HMAC signature, and when the trigger label is added to an issue, places one
 * WorkItem on the Factorial event bus. Nothing downstream knows about GitHub.
 */
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';

import { WORKITEM_DETAIL_TYPE, WORKITEM_EVENT_SOURCE, type WorkItem } from '@factorial/workitem';

import { decidePrEvent, isReworkRequestComment, type PrEventDecision } from './pr-event.ts';
import { BadPayloadError, decideIssueEvent } from './issue-event.ts';
import { buildRework, GitHubFetch } from './enrich.ts';
import { parseIssueCommentPayload } from './payloads.ts';
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
  const PR_EVENTS = new Set([
    'pull_request_review',
    'pull_request_review_comment',
    'issue_comment',
    'check_suite',
    'workflow_run',
  ]);
  if (githubEvent !== undefined && githubEvent !== 'issues' && !PR_EVENTS.has(githubEvent)) {
    return respond(202, { message: `ignored event "${githubEvent ?? ''}"` });
  }
  // Narrowed to a known event name by the checks above.
  const eventName = githubEvent as string;

  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    return respond(400, { message: 'body is not valid JSON' });
  }

  let workItem;
  let ignored: string | undefined;
  try {
    const decision =
      githubEvent === 'issues'
        ? decideIssueEvent(payload, {
            triggerLabel: process.env.TRIGGER_LABEL ?? 'factorial',
            allowedUserIds: allowedUserIds(),
            deliveryId,
          })
        : await prDecision(eventName, payload, deliveryId);
    if (decision.kind === 'ignore') {
      ignored = decision.reason;
    } else if ('workItem' in decision) {
      workItem = decision.workItem;
    }
  } catch (error) {
    if (error instanceof BadPayloadError) {
      console.warn(JSON.stringify({ message: 'rejected malformed payload', deliveryId, error: error.message }));
      return respond(400, { message: error.message });
    }
    throw error;
  }

  if (workItem === undefined) {
    return respond(202, { message: ignored ?? 'ignored' });
  }
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

/**
 * The App credentials, for the read-only GitHub lookups the PR rework path
 * needs. Only the trigger adapter reads these here; tokens are scoped to one
 * repository and `pull_requests: read`.
 */
async function appCredentials(): Promise<{ appId: string; installationId: string; privateKeyPem: string }> {
  const [params, key] = await Promise.all([
    new SSMClient({}).send(
      new GetParametersCommand({
        Names: [requireEnv('GITHUB_APP_ID_PARAM'), requireEnv('GITHUB_INSTALLATION_ID_PARAM')],
      }),
    ),
    new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: requireEnv('GITHUB_PRIVATE_KEY_SECRET') })),
  ]);
  const byName = new Map((params.Parameters ?? []).map((p) => [p.Name, p.Value]));
  const appId = byName.get(requireEnv('GITHUB_APP_ID_PARAM'));
  const installationId = byName.get(requireEnv('GITHUB_INSTALLATION_ID_PARAM'));
  if (!appId || !installationId || !key.SecretString) {
    throw new Error('Missing GitHub App configuration for the PR rework path');
  }
  return { appId, installationId, privateKeyPem: key.SecretString };
}

/**
 * Route a pull-request event: the pure decision function first, then, only if
 * it says rework, the GitHub and ledger lookups that complete the guards and
 * build the WorkItem. `issue_comment` payloads carry no PR shape, so the PR
 * record is fetched from the API before deciding, but only when the comment
 * body looks like a rework request.
 */
async function prDecision(
  githubEvent: string,
  payload: unknown,
  deliveryId: string | undefined,
): Promise<{ kind: 'ignore'; reason: string } | { kind: 'work'; workItem: WorkItem }> {
  const botLogin = requireEnv('FACTORIAL_BOT_LOGIN');
  const allowed = allowedUserIds();

  if (githubEvent === 'issue_comment') {
    const event = parseIssueCommentPayload(payload);
    if (event.action !== 'created') {
      return { kind: 'ignore', reason: `ignored issue_comment action "${event.action}"` };
    }
    if (!isReworkRequestComment(event.comment.body, botLogin)) {
      return { kind: 'ignore', reason: 'plain issue comment' };
    }
    const github = await GitHubFetch.create(event.repository, await appCredentials());
    const pullRequest = await github.getPullRequest(event.repository, event.issue.number);
    const enriched = { ...(payload as object), pull_request: pullRequest };
    const decision = decidePrEvent('issue_comment', enriched, { botLogin, allowedUserIds: allowed });
    if (decision.kind === 'ignore') return decision;
    const outcome = await buildRework(decision, event.repository, github, {
      deliveryId,
      baseBranch: decision.pullRequest.base.ref,
      botLogin,
    });
    return 'kind' in outcome && outcome.kind === 'ignore' ? outcome : { kind: 'work', workItem: outcome as WorkItem };
  }

  const decision = decidePrEvent(githubEvent as string, payload, { botLogin, allowedUserIds: allowed });
  if (decision.kind === 'ignore') return decision;
  const repository = repositoryOf(githubEvent as string, payload);
  const github = await GitHubFetch.create(repository, await appCredentials());
  const outcome = await buildRework(decision, repository, github, {
    deliveryId,
    baseBranch: decision.pullRequest.base.ref,
    botLogin,
  });
  return 'kind' in outcome && outcome.kind === 'ignore' ? outcome : { kind: 'work', workItem: outcome as WorkItem };
}

/** The repository of a PR-shaped event, for the API lookups. */
function repositoryOf(githubEvent: string, payload: unknown): { owner: { login: string }; name: string } {
  const record = payload as Record<string, unknown>;
  const repository = record.repository as { name?: unknown; owner?: { login?: unknown } } | undefined;
  if (
    repository === undefined ||
    typeof repository.name !== 'string' ||
    repository.owner === undefined ||
    typeof repository.owner.login !== 'string'
  ) {
    throw new BadPayloadError(`the ${githubEvent} payload has no repository`);
  }
  return { name: repository.name, owner: { login: repository.owner.login } };
}
