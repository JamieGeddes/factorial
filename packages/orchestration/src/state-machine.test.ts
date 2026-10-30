/**
 * Checks on the state machine definition in templates/orchestration.yml:
 * every state that produces output carries the run's key, so the execution
 * history reads consistently whichever path a run takes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

interface State {
  Type: string;
  Output?: Record<string, unknown> | string;
  Catch?: Array<{ ErrorEquals: string[]; Output?: Record<string, unknown> }>;
  Arguments?: { Payload?: Record<string, unknown> };
}

/** The DefinitionString block, with CloudFormation substitutions replaced so it parses as JSON. */
function definition(): { StartAt: string; States: Record<string, State> } {
  const template = readFileSync(new URL('../../../templates/orchestration.yml', import.meta.url), 'utf8');
  const lines = template.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'DefinitionString: |');
  assert.ok(start !== -1, 'DefinitionString not found');
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith('        ')) break;
    body.push(line);
  }
  return JSON.parse(body.join('\n').replace(/\$\{[A-Za-z]+\}/g, '0'));
}

const states = Object.entries(definition().States);

test('every Task and Pass state outputs the work item id', () => {
  for (const [name, state] of states.filter(([, s]) => s.Type === 'Task' || s.Type === 'Pass')) {
    assert.ok(typeof state.Output === 'object' && 'workItemId' in state.Output, `${name} output lacks workItemId`);
  }
});

test('every Task state also outputs the attempt', () => {
  for (const [name, state] of states.filter(([, s]) => s.Type === 'Task')) {
    assert.ok(typeof state.Output === 'object' && 'attempt' in state.Output, `${name} output lacks attempt`);
  }
});

test('every catcher outputs the work item id with the error', () => {
  for (const [name, state] of states) {
    for (const catcher of state.Catch ?? []) {
      assert.ok(catcher.Output && 'workItemId' in catcher.Output, `${name} catcher ${catcher.ErrorEquals.join(',')} lacks workItemId`);
      assert.ok('error' in catcher.Output, `${name} catcher ${catcher.ErrorEquals.join(',')} lacks error`);
    }
  }
});

test('Intake receives the execution ARN, so the ledger row leads to the execution (#203)', () => {
  const intake = definition().States.Intake;
  assert.equal(intake?.Arguments?.Payload?.executionArn, '{% $states.context.Execution.Id %}');
});
