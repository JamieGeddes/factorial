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
  Resource?: string;
  Arguments?: {
    Payload?: Record<string, unknown> | string;
    Overrides?: { ContainerOverrides?: Array<{ Environment?: Array<{ Name: string; Value: string }> }> };
  };
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
  const payload = intake?.Arguments?.Payload;
  assert.ok(typeof payload === 'object');
  assert.equal(payload.executionArn, '{% $states.context.Execution.Id %}');
});


test('every task tells its Lambda or invoker the state it runs in, for the progress record (#15)', () => {
  const tasks = states.filter(([, s]) => s.Type === 'Task');
  assert.ok(tasks.length > 0);
  for (const [name, state] of tasks) {
    if (state.Resource?.startsWith('arn:aws:states:::lambda:invoke')) {
      const payload = state.Arguments?.Payload;
      if (typeof payload === 'string') {
        assert.match(payload, /'progress': \{ 'stage': \$states\.context\.State\.Name, 'round': \$buildRound \}/, `${name} payload lacks progress`);
      } else {
        assert.deepEqual(payload?.progress, { stage: '{% $states.context.State.Name %}', round: '{% $buildRound %}' }, `${name} payload lacks progress`);
      }
    } else {
      const environment = state.Arguments?.Overrides?.ContainerOverrides?.[0]?.Environment ?? [];
      assert.ok(
        environment.some((variable) => variable.Name === 'STAGE' && variable.Value === '{% $states.context.State.Name %}'),
        `${name} does not pass STAGE`,
      );
    }
  }
});
