import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { stubServices } from '../../test/services.ts';
import { ID, ID2 } from '../../test/stubs.ts';
import { decide, sessionValue } from './guard.ts';
import { MAX_BODY_BYTES, postScores, reviewerName } from './scores.ts';
import type { LedgerRow } from '../lib/records.ts';

const ORIGIN = 'http://127.0.0.1:4757';
const SCORE = { verdict: 'request-changes', scores: { correctness: 4, completeness: 3, tests: 2, safety: 5 }, comment: 'The retry path has no test.' };

const row = (fields: Partial<LedgerRow> = {}): LedgerRow => ({ workItemId: ID, attempt: 2, status: 'pr-opened', result: 'pr-opened', reviewVerdict: 'approve', reviewScores: { correctness: 5, completeness: 4, tests: 4, safety: 5 }, ...fields });

const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  new Request(`${ORIGIN}/api/work-items/${ID}/scores`, { method: 'POST', headers: { origin: ORIGIN, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

/** Every write the stubs saw: object keys put, and ledger updates. */
const writes = (s: ReturnType<typeof stubServices>) => ({
  puts: s.clients.s3.calls.filter((c) => c.name === 'PutObjectCommand'),
  updates: s.clients.documents.calls.filter((c) => c.name === 'UpdateCommand'),
});

describe('reviewerName', () => {
  test("is the ARN's last part, made safe for a key", () => {
    assert.equal(reviewerName('arn:aws:sts::000000000000:assumed-role/AWSReservedSSO_Admin_0123/jamie@example.com'), 'jamie-example.com');
    assert.equal(reviewerName('arn:aws:iam::000000000000:user/team/alex.smith'), 'alex.smith');
    assert.equal(reviewerName('arn:aws:iam::000000000000:root'), 'root');
    assert.equal(reviewerName('arn:aws:sts::000000000000:federated-user/__sam'), 'sam');
    assert.equal(reviewerName(`arn:aws:iam::000000000000:user/${'a'.repeat(100)}`)?.length, 64);
    assert.equal(reviewerName('arn:aws:iam::000000000000:user/@@@'), undefined);
  });
});

describe('POST /api/work-items/{id}/scores', () => {
  test('creates the object and sets the reviewer entry; a resubmission is a new version of the same key and replaces the entry', async () => {
    const r = row();
    const s = stubServices({ rows: [r], now: Date.parse('2026-11-01T10:10:00Z') });
    const first = await postScores(post(SCORE), s, ID);
    assert.equal(first.status, 200);
    const key = `${ID}/2/scores/human-jamie-example.com.json`;
    const stored = JSON.parse((await s.artefacts.once(key)) ?? '{}');
    assert.deepEqual(stored, { schemaVersion: 1, ...SCORE, reviewer: 'jamie-example.com', attempt: 2, at: '2026-11-01T10:10:00.000Z' });
    assert.deepEqual(r.humanScores, { 'jamie-example.com': { attempt: 2, verdict: 'request-changes', scores: SCORE.scores, at: '2026-11-01T10:10:00.000Z' } });
    // The first score on a row creates the map, conditional on the row and on the map's absence.
    const created = writes(s).updates.at(-1)?.input;
    assert.equal(created?.UpdateExpression, 'SET #h = :map');
    assert.match(String(created?.ConditionExpression), /attribute_exists\(#id\)/);

    const again = await postScores(post({ ...SCORE, verdict: 'approve', scores: { ...SCORE.scores, tests: 4 } }), s, ID);
    assert.equal(again.status, 200);
    const { puts, updates } = writes(s);
    assert.deepEqual(puts.map((c) => c.input.Key), [key, key]);
    assert.equal(updates.at(-1)?.input.UpdateExpression, 'SET #h.#r = :entry');
    assert.equal(r.humanScores?.['jamie-example.com']?.verdict, 'approve');
    assert.equal(r.humanScores?.['jamie-example.com']?.scores?.tests, 4);
    // What is kept of the object was dropped, so the form reads the new version.
    assert.equal(JSON.parse((await s.artefacts.once(key)) ?? '{}').verdict, 'approve');
  });

  test('a second reviewer adds an entry beside the first', async () => {
    const r = row({ humanScores: { alex: { attempt: 2, verdict: 'approve', scores: SCORE.scores, at: '2026-11-01T09:00:00Z' } } });
    const s = stubServices({ rows: [r] });
    assert.equal((await postScores(post(SCORE), s, ID)).status, 200);
    assert.deepEqual(Object.keys(r.humanScores ?? {}).sort(), ['alex', 'jamie-example.com']);
  });

  test('writes nothing outside <id>/<attempt>/scores/, and only the humanScores entry on the row', async () => {
    const s = stubServices({ rows: [row()] });
    await postScores(post(SCORE), s, ID);
    await postScores(post(SCORE), s, ID);
    const { puts, updates } = writes(s);
    assert.ok(puts.length > 0);
    for (const p of puts) assert.match(String(p.input.Key), new RegExp(`^${ID}/2/scores/human-[A-Za-z0-9._-]+\\.json$`));
    for (const u of updates) {
      assert.deepEqual(u.input.Key, { workItemId: ID });
      assert.match(String(u.input.UpdateExpression), /^SET #h(\.#r)? = :(entry|map)$/);
      assert.equal((u.input.ExpressionAttributeNames as Record<string, string>)['#h'], 'humanScores');
    }
    assert.equal(s.clients.s3.calls.filter((c) => !['PutObjectCommand', 'GetObjectCommand'].includes(c.name)).length, 0);
  });

  test('writes nothing for an item with no row', async () => {
    const s = stubServices({ rows: [row()] });
    const response = await postScores(new Request(`${ORIGIN}/api/work-items/${ID2}/scores`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(SCORE) }), s, ID2);
    assert.equal(response.status, 404);
    assert.deepEqual(writes(s), { puts: [], updates: [] });
  });

  test('writes nothing for a body that is not a valid score', async () => {
    const s = stubServices({ rows: [row()] });
    const cases: [unknown, number, Record<string, string>?][] = [
      [SCORE, 415, { 'content-type': 'text/plain' }],
      ['{"verdict":', 400],
      [[SCORE], 400],
      [{ ...SCORE, verdict: 'reject' }, 400],
      [{ ...SCORE, scores: { ...SCORE.scores, safety: 6 } }, 400],
      [{ ...SCORE, scores: { correctness: 4 } }, 400],
      [{ ...SCORE, comment: 7 }, 400],
      [{ ...SCORE, comment: 'x'.repeat(8001) }, 400],
      // The reviewer, attempt and time are the server's, never the request's.
      [{ ...SCORE, reviewer: 'someone-else' }, 400],
      [{ ...SCORE, attempt: 1 }, 400],
      [`{"comment":"${'x'.repeat(MAX_BODY_BYTES)}"}`, 413],
    ];
    for (const [body, status, headers] of cases) {
      const response = await postScores(post(body, headers), s, ID);
      assert.equal(response.status, status, JSON.stringify(body).slice(0, 80));
    }
    assert.equal((await postScores(post(SCORE), s, 'not-an-id')).status, 400);
    assert.deepEqual(writes(s), { puts: [], updates: [] });
  });

  test('takes a missing comment as empty, and accepts one at the cap', async () => {
    const s = stubServices({ rows: [row()] });
    const { comment: _comment, ...bare } = SCORE;
    assert.equal((await postScores(post(bare), s, ID)).status, 200);
    assert.equal((await postScores(post({ ...SCORE, comment: 'x'.repeat(8000) }), s, ID)).status, 200);
  });

  test('redacts the comment before storing it', async () => {
    const s = stubServices({ rows: [row()] });
    const response = await postScores(post({ ...SCORE, comment: 'pasted ghp_abcdefghijklmnopqrstuvwxyz0123456789 by mistake' }), s, ID);
    const body = (await response.json()) as { score: { comment: string } };
    assert.equal(body.score.comment, 'pasted ghp_*** by mistake');
    const stored = String(writes(s).puts[0]?.input.Body);
    assert.ok(!stored.includes('abcdefghijklmnopqrstuvwxyz0123456789'));
  });

  test('without an AWS identity name, it writes nothing', async () => {
    const s = stubServices({ rows: [row()], arn: 'arn:aws:iam::000000000000:user/@@@' });
    const response = await postScores(post(SCORE), s, ID);
    assert.equal(response.status, 502);
    assert.deepEqual(writes(s), { puts: [], updates: [] });
  });

  test('a request without the app cookie, or from another origin, never reaches the route', () => {
    const config = { token: 'secret-token', port: '4757' };
    const request = { url: new URL(`${ORIGIN}/api/work-items/${ID}/scores`), method: 'POST', host: '127.0.0.1:4757' };
    assert.deepEqual(decide({ ...request, origin: ORIGIN, cookie: undefined }, config), { kind: 'deny', status: 401, reason: 'not signed in: open the URL printed at start' });
    assert.equal((decide({ ...request, origin: 'https://evil.example', cookie: sessionValue('secret-token') }, config) as { status: number }).status, 403);
    assert.equal((decide({ ...request, origin: null, cookie: sessionValue('secret-token') }, config) as { status: number }).status, 403);
    assert.equal(decide({ ...request, origin: ORIGIN, cookie: sessionValue('secret-token') }, config).kind, 'allow');
  });
});
