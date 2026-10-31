import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { BedrockAgentCoreClient, InvokeAgentRuntimeCommandCommand, StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { collectReview, type CollectReviewInput } from './collect-review.ts';
import type { WorkContext } from '../lib/context.ts';
import type { Logger } from '../lib/log.ts';

const WORK_ITEM_ID = '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c';
const ENV = { BUILDER_RUNTIME_ARN: 'arn:builder', REVIEWER_RUNTIME_ARN: 'arn:reviewer', RUNTIME_QUALIFIER: 'live', ARTEFACT_BUCKET: 'bucket', TABLE_NAME: 'table' };
const review = readFileSync(new URL('../../../../contracts/review/v1/examples/approve.json', import.meta.url), 'utf8');

const input: CollectReviewInput = {
  ctx: { workItem: { id: WORK_ITEM_ID }, sessionId: WORK_ITEM_ID, attempt: 1, artefactPrefix: `${WORK_ITEM_ID}/1/` } as unknown as WorkContext,
  sensitive: [],
};
const log = { info: () => {}, error: () => {}, with: () => log } as Logger;

describe('collectReview stops the reviewer session once it has finished with it', () => {
  let saved: Record<string, string | undefined>;
  let stopped: Array<{ arn: string | undefined; qualifier: string | undefined; sessionId: string | undefined }>;
  /** What the review file read answers, or an error to throw. */
  let fileRead: string | Error;
  let failStop: boolean;

  beforeEach(() => {
    saved = Object.fromEntries(Object.keys(ENV).map((name) => [name, process.env[name]]));
    Object.assign(process.env, ENV);
    stopped = [];
    failStop = false;
    fileRead = `ok:${review.length}:${Buffer.from(review).toString('base64')}`;
    mock.method(S3Client.prototype, 'send', async () => ({}));
    mock.method(DynamoDBDocumentClient.prototype, 'send', async () => ({}));
    mock.method(BedrockAgentCoreClient.prototype, 'send', async (command: unknown) => {
      if (command instanceof StopRuntimeSessionCommand) {
        stopped.push({ arn: command.input.agentRuntimeArn, qualifier: command.input.qualifier, sessionId: command.input.runtimeSessionId });
        if (failStop) throw new Error('stop denied');
        return {};
      }
      assert.ok(command instanceof InvokeAgentRuntimeCommandCommand);
      if (fileRead instanceof Error) throw fileRead;
      return { stream: [{ chunk: { contentDelta: { stdout: fileRead } } }, { chunk: { contentStop: { exitCode: 0 } } }] };
    });
  });
  afterEach(() => {
    mock.restoreAll();
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('stops it after an accepted review', async () => {
    const result = await collectReview(input, log);
    assert.equal(result.ok, true);
    assert.deepEqual(stopped, [{ arn: 'arn:reviewer', qualifier: 'live', sessionId: WORK_ITEM_ID }]);
  });

  it('stops it after a review that is missing or invalid', async () => {
    fileRead = 'missing:';
    const result = await collectReview(input, log);
    assert.equal(result.ok, false);
    assert.deepEqual(stopped, [{ arn: 'arn:reviewer', qualifier: 'live', sessionId: WORK_ITEM_ID }]);
  });

  it('does not stop it when reading fails, so the retry finds the session', async () => {
    fileRead = new Error('read failed');
    await assert.rejects(collectReview(input, log), /read failed/);
    assert.deepEqual(stopped, []);
  });

  it('still succeeds when the stop fails', async () => {
    failStop = true;
    const result = await collectReview(input, log);
    assert.equal(result.ok, true);
    assert.equal(stopped.length, 1);
  });
});
