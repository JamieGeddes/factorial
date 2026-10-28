import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { RUN_REASONS, outcomeOfReason, validateInvocation, validateRunEvent, validateRunStatus } from './index.ts';

const examplesDir = fileURLToPath(new URL('../../../contracts/run/v1/examples/', import.meta.url));
const example = async (name: string): Promise<unknown> => JSON.parse(await readFile(path.join(examplesDir, name), 'utf8'));

const ended = { type: 'run.ended', outcome: 'complete', reason: 'completed' };

describe('run events', () => {
  for (const file of ['builder-complete.json', 'other-provider-incomplete.json']) {
    it(`accepts every event in ${file}`, async () => {
      for (const event of (await example(file)) as unknown[]) {
        const result = validateRunEvent(event);
        assert.ok(result.ok, `${JSON.stringify(event)}: ${result.ok ? '' : result.errors.join('; ')}`);
      }
    });
  }

  it('checks only the envelope of an event type it does not know', () => {
    assert.ok(validateRunEvent({ type: 'budget.warning', remainingUsd: 1 }).ok);
    assert.ok(validateRunEvent({ ...ended, newField: true }).ok);
    assert.equal(validateRunEvent({ kind: 'text' }).ok, false);
    assert.equal(validateRunEvent({ type: 'Not A Type' }).ok, false);
  });

  it('rejects a known event missing what the invoker needs', () => {
    assert.equal(validateRunEvent({ type: 'model.call' }).ok, false);
    assert.equal(validateRunEvent({ type: 'model.call', usage: { inputTokens: -1, outputTokens: 0 } }).ok, false);
    assert.equal(validateRunEvent({ type: 'tool.call', tool: 'Bash', input: {} }).ok, false);
    assert.equal(validateRunEvent({ type: 'run.started', contract: 2, harness: { name: 'x' }, role: 'builder', models: [{ purpose: 'main', id: 'm' }] }).ok, false);
    assert.equal(validateRunEvent({ type: 'run.started', contract: 1, harness: { name: 'x' }, role: 'builder', models: [{ id: 'm' }] }).ok, false);
  });

  it('closes the outcome and leaves the reason open', () => {
    assert.ok(validateRunEvent({ ...ended, outcome: 'incomplete', reason: 'context_exhausted' }).ok);
    const result = validateRunEvent({ ...ended, outcome: 'partly' });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((e) => e.includes('/outcome')), 'names the field');
  });
});

describe('run status', () => {
  it('accepts the example and a status before the run ends', async () => {
    assert.ok(validateRunStatus(await example('status-finished.json')).ok);
    assert.ok(validateRunStatus({ contract: 1, state: 'running', events: 3 }).ok);
    assert.equal(validateRunStatus({ contract: 1, state: 'done', events: 3 }).ok, false);
    assert.equal(validateRunStatus({ state: 'running', events: 3 }).ok, false);
  });
});

describe('invocations', () => {
  it('needs the contract version on a run', () => {
    assert.ok(validateInvocation({ action: 'run', contract: 1, prompt: 'go', round: 1 }).ok);
    assert.equal(validateInvocation({ action: 'run', prompt: 'go', round: 1 }).ok, false);
    assert.equal(validateInvocation({ action: 'run', contract: 2, prompt: 'go', round: 1 }).ok, false);
    assert.ok(validateInvocation({ action: 'attach', after: 4 }).ok);
    assert.ok(validateInvocation({ action: 'status' }).ok);
  });
});

describe('outcomeOfReason', () => {
  it('maps every known reason and no other', () => {
    for (const [reason, outcome] of Object.entries(RUN_REASONS)) assert.equal(outcomeOfReason(reason), outcome);
    assert.equal(outcomeOfReason('context_exhausted'), undefined);
    assert.equal(outcomeOfReason('toString'), undefined);
  });
});
