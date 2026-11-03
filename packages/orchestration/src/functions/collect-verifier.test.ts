import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateVerifierResult, type Verifier, type VerifierResult } from '@factorial/verifiers';

import type { WorkContext } from '../lib/context.ts';
import { checkedResult, missingResult, type CollectVerifierInput } from './collect-verifier.ts';
import { prepareVerifyStage, verifierCheckout } from './prepare-verify.ts';

const ID = '7f3c1d2e-5b7a-4c7e-9a1b-2d3e4f5a6b7c';
const HEAD = 'c'.repeat(40);
const checks: Verifier = { name: 'checks', kind: 'command', run: 'npm test', required: true, timeoutSeconds: 600 };
const ctx = {
  workItem: { id: ID, repository: { provider: 'github', owner: 'JamieGeddes', name: 'factorial' } },
  branch: 'factorial/x',
  artefactPrefix: `${ID}/1/`,
} as unknown as WorkContext;

const stored = (overrides: Partial<VerifierResult> = {}): string =>
  JSON.stringify({
    schemaVersion: 1,
    name: 'checks',
    kind: 'command',
    required: true,
    sha: HEAD,
    outcome: 'passed',
    exitCode: 0,
    startedAt: '2026-11-02T10:00:00.000Z',
    finishedAt: '2026-11-02T10:01:00.000Z',
    durationSeconds: 60,
    ...overrides,
  });

describe('checkedResult', () => {
  it("takes a valid result for this verifier on this commit, with the base branch's say on whether it is required", () => {
    const { result } = checkedResult(stored({ required: false }), checks, HEAD);
    assert.equal(result?.outcome, 'passed');
    assert.equal(result?.required, true);
  });

  it('refuses a missing result, an invalid one, one for another verifier and one for another commit', () => {
    assert.match(checkedResult(undefined, checks, HEAD).problem ?? '', /no result/);
    assert.match(checkedResult('{', checks, HEAD).problem ?? '', /not valid/);
    assert.match(checkedResult(stored({ name: 'lint' }), checks, HEAD).problem ?? '', /for lint/);
    assert.match(checkedResult(stored({ sha: 'd'.repeat(40) }), checks, HEAD).problem ?? '', /not c+/);
  });
});

describe('missingResult', () => {
  const input = (error: { Error?: string } | null): CollectVerifierInput => ({ ctx, collect: { headSha: HEAD }, verifier: checks, index: 0, error, startedAt: '2026-11-02T10:00:00.000Z' });
  const now = new Date('2026-11-02T10:10:00.000Z');

  it('records a state timeout as timed-out, and any other failure as error: never a pass', () => {
    const timedOut = missingResult(input({ Error: 'States.Timeout' }), HEAD, 'the step failed', now);
    assert.equal(timedOut.outcome, 'timed-out');
    assert.equal(timedOut.durationSeconds, 600);
    const failed = missingResult(input({ Error: 'States.TaskFailed' }), HEAD, 'the step failed', now);
    assert.equal(failed.outcome, 'error');
    assert.match(failed.detail ?? '', /States\.TaskFailed/);
    const none = missingResult(input(null), HEAD, 'no result was written', now);
    assert.equal(none.detail, 'no result was written');
    for (const result of [timedOut, failed, none]) assert.ok(validateVerifierResult(result).ok);
  });
});

describe('PrepareVerify', () => {
  it("checks out the work branch at the tested commit, in the verifier's own session on the verifier Runtime", () => {
    const params = verifierCheckout({ ctx, collect: { headSha: HEAD }, verifier: checks, index: 1 });
    assert.equal(params.role, 'verifier');
    assert.equal(params.at, HEAD);
    assert.equal(params.existing, true);
    assert.equal(params.sessionId, `${ID}-verify-2`);
    assert.equal(params.stage, 'verify/checks');
  });

  it('refuses a head that is not a commit sha', () => {
    assert.throws(() => verifierCheckout({ ctx, collect: { headSha: 'main' }, verifier: checks, index: 0 }), /not a commit sha/);
  });

  it('leaves the Verify stage open whether it succeeds or fails: CollectVerifier and the states after it end it', () => {
    assert.deepEqual(prepareVerifyStage, { endsLater: true, failureEndsLater: true });
  });
});
