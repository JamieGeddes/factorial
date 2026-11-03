import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateVerifierResult } from '@factorial/verifiers';

import { MAX_COMMAND_SECONDS, OutputTail, checkCommand, commandTimeoutSeconds, outcomeOf, verifierResult, verifyTask } from './verifier.ts';

const WORK_ITEM = '0b6e1f3a-0c1d-4e2f-9a3b-4c5d6e7f8a9b';
const SHA = '3bda0de2c4f1e5a6b7c8d9e0f1a2b3c4d5e6f7a8';
const verifier = { name: 'checks', kind: 'command', run: "npm ci && echo 'ok'", required: true, timeoutSeconds: 600 };
const env = (overrides: Record<string, string> = {}): Record<string, string> => ({
  RUNTIME_ARN: 'arn:aws:bedrock-agentcore:eu-west-1:123456789012:runtime/factorial_verifier-AbC123',
  RUNTIME_QUALIFIER: 'live',
  WORK_ITEM_ID: WORK_ITEM,
  SESSION_ID: `${WORK_ITEM}-verify-1`,
  ARTEFACT_PREFIX: `${WORK_ITEM}/1/`,
  VERIFY_SHA: SHA,
  VERIFIER: JSON.stringify(verifier),
  ...overrides,
});

describe('verifyTask', () => {
  it('reads the task', () => {
    const task = verifyTask(env());
    assert.equal(task.target.sessionId, `${WORK_ITEM}-verify-1`);
    assert.deepEqual(task.verifier, verifier);
  });

  it("refuses a role's Runtime: a check never runs in an agent's session", () => {
    assert.throws(() => verifyTask(env({ RUNTIME_ARN: 'arn:aws:bedrock-agentcore:eu-west-1:123456789012:runtime/factorial_builder-AbC123' })), /verifier runtime/);
  });

  it("refuses a session or prefix that is not the work item's, and a verifier it cannot run", () => {
    assert.throws(() => verifyTask(env({ SESSION_ID: WORK_ITEM })));
    assert.throws(() => verifyTask(env({ ARTEFACT_PREFIX: '11111111-2222-4333-8444-555555555555/1/' })));
    assert.throws(() => verifyTask(env({ VERIFY_SHA: 'main' })));
    assert.throws(() => verifyTask(env({ VERIFIER: JSON.stringify({ ...verifier, kind: 'sandbox' }) })));
    assert.throws(() => verifyTask(env({ VERIFIER: JSON.stringify({ ...verifier, timeoutSeconds: MAX_COMMAND_SECONDS }) })));
  });
});

describe('checkCommand', () => {
  it('sends the image runner a line with no shell syntax: the command is base64', () => {
    const line = checkCommand(verifier);
    assert.match(line, /^node \/opt\/factorial\/agent-runtime\/verify\.mjs 600 [A-Za-z0-9+/]+=*$/);
    assert.equal(Buffer.from(line.split(' ')[3]!, 'base64').toString('utf8'), verifier.run);
  });

  it('gives the session command a margin over the check, within the hour', () => {
    assert.equal(commandTimeoutSeconds({ timeoutSeconds: 600 }), 720);
    assert.equal(commandTimeoutSeconds({ timeoutSeconds: 3500 }), MAX_COMMAND_SECONDS);
  });
});

describe('OutputTail', () => {
  it('keeps everything under the limit', () => {
    const tail = new OutputTail(10);
    tail.add('abc');
    tail.add(Buffer.from('def'));
    assert.equal(tail.text(), 'abcdef');
    assert.equal(tail.truncated, false);
  });

  it('keeps the end of a long stream and says how much went', () => {
    const tail = new OutputTail(8);
    for (const chunk of ['0123', '4567', '89ab', 'cdef']) tail.add(chunk);
    assert.equal(tail.bytes, 16);
    assert.equal(tail.truncated, true);
    assert.equal(tail.text(), '[the first 8 bytes of output are not kept]\n89abcdef');
  });
});

describe('outcomeOf', () => {
  it('reads exit statuses', () => {
    assert.deepEqual(outcomeOf(0, 5, 600), { outcome: 'passed' });
    assert.equal(outcomeOf(1, 5, 600).outcome, 'failed');
    assert.equal(outcomeOf(124, 600, 600).outcome, 'timed-out');
    assert.equal(outcomeOf(137, 631, 600).outcome, 'timed-out');
    assert.equal(outcomeOf(137, 20, 600).outcome, 'failed');
    assert.equal(outcomeOf(125, 1, 600).outcome, 'error');
    assert.equal(outcomeOf(127, 1, 600).outcome, 'error');
    assert.equal(outcomeOf(-1, 1, 600).outcome, 'error');
  });
});

describe('verifierResult', () => {
  it('meets the result contract', () => {
    const task = verifyTask(env());
    const result = verifierResult({
      task,
      outcome: 'timed-out',
      exitCode: 124,
      detail: 'stopped\nafter 600 seconds',
      startedAt: new Date('2026-11-02T10:00:00Z'),
      finishedAt: new Date('2026-11-02T10:10:00.400Z'),
      log: { key: `${WORK_ITEM}/1/verify/checks/output.log`, bytes: 10, truncated: false },
    });
    assert.equal(result.durationSeconds, 600);
    assert.equal(result.detail, 'stopped after 600 seconds');
    const checked = validateVerifierResult(result);
    assert.ok(checked.ok, checked.ok ? '' : checked.errors.join('; '));
  });

  it('leaves out an exit status the command never gave', () => {
    const result = verifierResult({ task: verifyTask(env()), outcome: 'error', exitCode: -1, startedAt: new Date(), finishedAt: new Date() });
    assert.equal('exitCode' in result, false);
  });
});
