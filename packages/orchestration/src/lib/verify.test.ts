import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Verifier } from '@factorial/verifiers';

import { VerifierFailedError, failedVerifierOf, unverifiedHead, verifyPlan, verifyProblemsOf, type VerifierDigest, type VerifyPlan } from './verify.ts';

const repo = { owner: 'JamieGeddes', name: 'other' };
const HEAD = 'a'.repeat(40);
const checks: Verifier = { name: 'checks', kind: 'command', run: 'npm test', required: true, timeoutSeconds: 600 };
const lint: Verifier = { name: 'lint', kind: 'command', run: 'npm run lint', required: false, timeoutSeconds: 120 };
const settings = (verifiers: unknown[]): string => JSON.stringify({ schemaVersion: 1, verifiers });
const ran = (verifier: Verifier, outcome: VerifierDigest['outcome'], sha = HEAD): VerifierDigest => ({ name: verifier.name, required: verifier.required, outcome, sha, durationSeconds: 10 });

describe('verifyPlan', () => {
  it('reads the settings from the base branch, never the work branch', async () => {
    const asked: string[] = [];
    const plan = await verifyPlan(repo, 'main', async (_repo, path, ref, max) => (asked.push(`${ref}:${path}:${max}`), settings([checks])));
    assert.deepEqual(asked, ['main:.factorial/verifiers.json:65536']);
    assert.deepEqual(plan, { verifiers: [checks] });
  });

  it('skips Verify, saying why, when the target declares no verifiers', async () => {
    assert.deepEqual(await verifyPlan(repo, 'develop', async () => undefined), { skipped: 'JamieGeddes/other declares no verifiers (no .factorial/verifiers.json on develop)' });
  });

  it("lists an invalid file's problems, so the turn ends rather than going unverified", async () => {
    const plan = await verifyPlan(repo, 'main', async () => settings([{ ...checks, kind: 'shell' }]));
    assert.ok('invalid' in plan && plan.invalid.length > 0, JSON.stringify(plan));
  });

  it('fails rather than skipping when GitHub cannot say', async () => {
    await assert.rejects(verifyPlan(repo, 'main', async () => { throw new Error('GitHub GET failed: 403'); }), /403/);
  });
});

describe('unverifiedHead', () => {
  const declared: VerifyPlan = { verifiers: [checks, lint] };

  it('passes a head every required verifier passed on, whatever the optional ones did', () => {
    assert.equal(unverifiedHead(declared, { verifiers: [ran(checks, 'passed'), ran(lint, 'failed')] }, HEAD), undefined);
  });

  it('passes an unverified head only when the target declares no verifiers', () => {
    assert.equal(unverifiedHead({ skipped: 'none' }, { skipped: 'none' }, HEAD), undefined);
    assert.match(unverifiedHead(declared, { skipped: 'none' }, HEAD) ?? '', /none ran/);
    assert.match(unverifiedHead({ invalid: ['x'] }, { skipped: 'none' }, HEAD) ?? '', /invalid/);
  });

  it('refuses a head another commit was verified on, a required verifier that did not pass, and one that never ran', () => {
    assert.match(unverifiedHead(declared, { verifiers: [ran(checks, 'passed', 'b'.repeat(40))] }, HEAD) ?? '', /ran on b+, but the branch head is a+/);
    assert.match(unverifiedHead(declared, { verifiers: [ran(checks, 'timed-out')] }, HEAD) ?? '', /required verifier checks timed-out/);
    assert.match(unverifiedHead(declared, { verifiers: [ran(lint, 'passed')] }, HEAD) ?? '', /required verifier checks did not run/);
  });
});

describe('the failure causes Report reads', () => {
  it("reads the failed verifier back from a Lambda error's cause", () => {
    const error = new VerifierFailedError(ran(checks, 'error'));
    assert.equal(error.name, 'VerifierFailed');
    const cause = JSON.stringify({ errorType: error.name, errorMessage: error.message });
    assert.deepEqual(failedVerifierOf(cause), { name: 'checks', outcome: 'error' });
    assert.equal(failedVerifierOf('not json'), undefined);
    assert.equal(failedVerifierOf(JSON.stringify({ errorMessage: JSON.stringify({ name: '../x', outcome: 'failed' }) })), undefined);
  });

  it("reads the settings' problems from the state machine's cause", () => {
    assert.deepEqual(verifyProblemsOf(JSON.stringify({ problems: ['a', 1, 'b'] })), ['a', 'b']);
    assert.deepEqual(verifyProblemsOf('nope'), []);
  });
});
