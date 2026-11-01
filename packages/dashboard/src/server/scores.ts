import 'server-only';

import { PutObjectCommand } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { artefactObject, artefactPrefix } from '@factorial/artefacts';
import { HUMAN_COMMENT_MAX, validateHumanScore, type HumanScore } from '@factorial/review';

import type { LedgerRow } from '../lib/records.ts';
import { isWorkItemId } from './artefacts.ts';
import type { Sender } from './aws.ts';
import type { Services } from './services.ts';

/**
 * Human scores (#227): the command centre's only write. A reviewer records a
 * verdict and four scores on a work item's current attempt; the score is
 * stored beside the reviewer agent's review, as
 * `<workItemId>/<attempt>/scores/human-<reviewer>.json`, and summarised on the
 * ledger row as `humanScores.<reviewer>`, for the views and the retrospective
 * trigger (#60).
 *
 * The local app has no sign-in, so the reviewer is the AWS identity the
 * server runs as, never anything the request says. The localhost protections
 * (`guard.ts`) apply as to every request: without the app's cookie, from
 * another origin or another host, nothing reaches this module.
 */
export interface ScoreInput {
  verdict: unknown;
  scores: unknown;
  comment?: unknown;
}

export type SubmitResult = { ok: true; score: HumanScore; key: string } | { ok: false; status: 400 | 404 | 409; errors: string[] };

export interface ScoreWriter {
  /** Who is scoring: the last part of the caller identity's ARN, safe for a key. Read once per process. */
  reviewer(): Promise<string>;
  /** Store one score on the row's current attempt, recorded at `now`, and set the reviewer's entry on the row. */
  submit(row: LedgerRow, input: ScoreInput, now: number): Promise<SubmitResult>;
}

/** The artefact path of a reviewer's score, under the attempt's prefix. */
export const scorePath = (reviewer: string): string => `scores/human-${reviewer}.json`;

/**
 * An ARN's last part (an IAM user name or role session name; `root` for the
 * account root), with anything but letters, digits, `.`, `_` and `-` replaced
 * by `-`, at most 64 characters, starting with a letter or digit.
 */
export function reviewerName(arn: string): string | undefined {
  const resource = arn.split(':').slice(5).join(':');
  const last = resource.split('/').pop() ?? '';
  const safe = last
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 64);
  return safe || undefined;
}

const isConditionFailure = (error: unknown): boolean => (error as { name?: string }).name === 'ConditionalCheckFailedException';

export interface ScoreClients {
  sts: Sender;
  s3: Sender;
  documents: Sender;
}

export function createScoreWriter(clients: ScoreClients, where: () => Promise<{ bucket: string; workItemsTable: string }>): ScoreWriter {
  let identity: Promise<string> | undefined;
  const reviewer = (): Promise<string> => {
    identity ??= (async () => {
      const result = (await clients.sts.send(new GetCallerIdentityCommand({}))) as { Arn?: string };
      const name = result.Arn ? reviewerName(result.Arn) : undefined;
      if (!name) throw new Error('the AWS identity has no name to record a score under');
      return name;
    })();
    identity.catch(() => (identity = undefined));
    return identity;
  };

  /**
   * `humanScores.<reviewer>` in one conditional UpdateItem. DynamoDB cannot
   * set a key in a map the row does not have yet, so the first score on a row
   * creates the map instead (conditional on its absence), and a second writer
   * racing it falls back to the first form. Every form requires the row.
   */
  const setEntry = async (table: string, id: string, name: string, entry: Record<string, unknown>): Promise<boolean> => {
    const key = { workItemId: id };
    const names = { '#id': 'workItemId', '#h': 'humanScores', '#r': name };
    const inMap = () =>
      clients.documents.send(
        new UpdateCommand({
          TableName: table,
          Key: key,
          UpdateExpression: 'SET #h.#r = :entry',
          ConditionExpression: 'attribute_exists(#id) AND attribute_exists(#h)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: { ':entry': entry },
        }),
      );
    try {
      await inMap();
      return true;
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
    try {
      await clients.documents.send(
        new UpdateCommand({
          TableName: table,
          Key: key,
          UpdateExpression: 'SET #h = :map',
          ConditionExpression: 'attribute_exists(#id) AND attribute_not_exists(#h)',
          ExpressionAttributeNames: { '#id': 'workItemId', '#h': 'humanScores' },
          ExpressionAttributeValues: { ':map': { [name]: entry } },
        }),
      );
      return true;
    } catch (error) {
      if (!isConditionFailure(error)) throw error;
    }
    try {
      await inMap();
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  };

  return {
    reviewer,
    async submit(row, input, now) {
      const comment = input.comment ?? '';
      if (typeof comment !== 'string') return { ok: false, status: 400, errors: ['/comment must be a string'] };
      if (comment.length > HUMAN_COMMENT_MAX) return { ok: false, status: 400, errors: [`/comment must NOT have more than ${HUMAN_COMMENT_MAX} characters`] };
      const attempt = typeof row.attempt === 'number' ? row.attempt : 1;
      const name = await reviewer();
      const candidate = { schemaVersion: 1, verdict: input.verdict, scores: input.scores, comment, reviewer: name, attempt, at: new Date(now).toISOString() };
      const checked = validateHumanScore(candidate);
      if (!checked.ok) return { ok: false, status: 400, errors: checked.errors };
      const { bucket, workItemsTable } = await where();
      // artefactObject is putArtefact's upload: the text redacted, the key checked to be under the attempt's prefix.
      const object = artefactObject(bucket, artefactPrefix(row.workItemId, attempt), scorePath(name), `${JSON.stringify(checked.value, null, 2)}\n`, 'application/json');
      await clients.s3.send(new PutObjectCommand(object));
      const stored = JSON.parse(String(object.Body)) as HumanScore;
      const entry = { attempt, verdict: stored.verdict, scores: stored.scores, at: stored.at };
      if (!(await setEntry(workItemsTable, row.workItemId, name, entry))) return { ok: false, status: 409, errors: ['the ledger row has gone'] };
      return { ok: true, score: stored, key: String(object.Key) };
    },
  };
}

/** The most a request body may hold: a comment at its cap, four bytes a character, and the rest. */
export const MAX_BODY_BYTES = 40 * 1024;

const answer = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/**
 * `POST /api/work-items/{id}/scores`, body `{ verdict, scores, comment }`.
 * Writes nothing unless the item has a ledger row and the body is a valid
 * score; then the score object, then the row's entry.
 */
export async function postScores(request: Request, services: Services, id: string): Promise<Response> {
  try {
    if (!isWorkItemId(id)) return answer({ error: 'not a work item id' }, 400);
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return answer({ error: 'send JSON' }, 415);
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > MAX_BODY_BYTES) return answer({ error: 'too large' }, 413);
    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return answer({ error: 'too large' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return answer({ error: 'not JSON' }, 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return answer({ error: 'send an object' }, 400);
    const extra = Object.keys(body).filter((k) => !['verdict', 'scores', 'comment'].includes(k));
    if (extra.length) return answer({ error: `unexpected ${extra.map((k) => JSON.stringify(k.slice(0, 40))).join(', ')}` }, 400);
    const row = await services.ledger.fresh(id);
    if (!row) return answer({ error: 'no such work item' }, 404);
    const result = await services.scores.submit(row, body as ScoreInput, services.now());
    if (!result.ok) return answer({ error: result.errors.join('; ').slice(0, 500) }, result.status);
    services.ledger.forget(id);
    services.artefacts.forget(result.key);
    return answer({ score: result.score });
  } catch (error) {
    const name = (error as { name?: string }).name ?? 'Error';
    const message = error instanceof Error ? error.message : String(error);
    console.error(`score route failed: ${name}: ${message}`);
    const status = /CredentialsProviderError|ExpiredToken|UnrecognizedClient|AccessDenied/.test(name) ? 503 : 502;
    return answer({ error: `${name}: ${message}`.slice(0, 300) }, status);
  }
}
