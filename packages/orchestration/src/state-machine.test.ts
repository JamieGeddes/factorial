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
  Next?: string;
  Default?: string;
  Choices?: Array<{ Condition: string; Next: string }>;
  Assign?: Record<string, unknown>;
  Output?: Record<string, unknown> | string;
  Catch?: Array<{ ErrorEquals: string[]; Output?: Record<string, unknown> }>;
  Resource?: string;
  TimeoutSeconds?: number | string;
  Arguments?: {
    Payload?: Record<string, unknown> | string;
    Overrides?: { ContainerOverrides?: Array<{ Name?: string; Environment?: Array<{ Name: string; Value: string }> }> };
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

interface Container extends State {
  ItemProcessor?: { StartAt: string; States: Record<string, State> };
}

/** Every state, those inside a Map's processor too. */
function allStates(from: Record<string, Container>): Array<[string, Container]> {
  return Object.entries(from).flatMap(([name, state]) => [[name, state] as [string, Container], ...(state.ItemProcessor ? allStates(state.ItemProcessor.States) : [])]);
}

const machine = definition().States as Record<string, Container>;
const states = allStates(machine);
/** The states that run one verifier: they record their progress against the Verify stage they belong to. */
const verifierStates = new Set(Object.keys(machine.Verify?.ItemProcessor?.States ?? {}));

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
    const stage = verifierStates.has(name) ? 'Verify' : '{% $states.context.State.Name %}';
    if (state.Resource?.startsWith('arn:aws:states:::lambda:invoke')) {
      const payload = state.Arguments?.Payload;
      if (typeof payload === 'string') {
        assert.match(payload, /'progress': \{ 'stage': \$states\.context\.State\.Name, 'round': \$buildRound \}/, `${name} payload lacks progress`);
      } else {
        assert.deepEqual(payload?.progress, { stage, round: '{% $buildRound %}' }, `${name} payload lacks progress`);
      }
    } else {
      const container = state.Arguments?.Overrides?.ContainerOverrides?.[0];
      // The verifier task records no progress: PrepareVerify and CollectVerifier around it do.
      if (container?.Name === 'verifier') continue;
      const environment = container?.Environment ?? [];
      assert.ok(environment.some((variable) => variable.Name === 'STAGE' && variable.Value === stage), `${name} does not pass STAGE`);
    }
  }
});

test('a pushed change is verified, skips Verify when its target declares no verifiers, and ends the turn when the settings are invalid', () => {
  const choices = machine.HasChanges?.Choices ?? [];
  // A proposal is checked first, then the invalid file and the skip: none of them reaches Verify.
  assert.deepEqual(choices.map((c) => c.Next), ['ReportProposed', 'VerifyUnconfigured', 'SkipVerify', 'Verify']);
  assert.match(choices[1]?.Condition ?? '', /\$collect\.pushed = true and \$exists\(\$collect\.verify\.invalid\)/);
  assert.match(choices[2]?.Condition ?? '', /\$collect\.pushed = true and \$exists\(\$collect\.verify\.skipped\)/);
  assert.equal(machine.HasChanges?.Default, 'ReportNoChanges');
  assert.equal(machine.SkipVerify?.Type, 'Pass');
  assert.equal(machine.SkipVerify?.Next, 'PrepareReview');
  assert.equal(machine.SkipVerify?.Assign?.verify, "{% { 'skipped': $collect.verify.skipped } %}");
  assert.equal(machine.VerifyUnconfigured?.Next, 'ReportFailure');
  assert.match(String(machine.VerifyUnconfigured?.Assign?.failure), /'Error': 'VerifyUnconfigured'/);
});

test('Verify runs the declared verifiers one at a time, each through PrepareVerify, RunVerifier and CollectVerifier', () => {
  const verify = machine.Verify as Container & { Items?: string; MaxConcurrency?: number };
  assert.equal(verify.Type, 'Map');
  assert.equal(verify.Items, '{% $collect.verify.verifiers %}');
  assert.equal(verify.MaxConcurrency, 1);
  assert.equal(verify.Next, 'PrepareReview');
  assert.deepEqual(verify.Catch?.map((c) => [c.ErrorEquals, (c as { Next?: string }).Next]), [
    [['VerifierFailed'], 'ReportTestsFailed'],
    [['States.ALL'], 'ReportFailure'],
  ]);
  const inner = verify.ItemProcessor?.States ?? {};
  assert.equal(verify.ItemProcessor?.StartAt, 'Verifier');
  assert.deepEqual(
    Object.entries(inner).map(([name, state]) => [name, state.Next ?? (state as { End?: boolean }).End]),
    [['Verifier', 'PrepareVerify'], ['PrepareVerify', 'RunVerifier'], ['RunVerifier', 'CollectVerifier'], ['CollectVerifier', true]],
  );
  // A failed seed or run is still judged, as the verifier's error or timeout.
  for (const name of ['PrepareVerify', 'RunVerifier']) assert.deepEqual(inner[name]?.Catch?.map((c) => (c as { Next?: string }).Next), ['CollectVerifier'], name);
  // The verifier's own task, never the invoker: the check runs in a container
  // with the verifier's role, given the bundle PrepareVerify made.
  const run = inner.RunVerifier;
  assert.equal(run?.Resource, 'arn:aws:states:::ecs:runTask.sync');
  const container = run?.Arguments?.Overrides?.ContainerOverrides?.[0];
  assert.equal(container?.Name, 'verifier');
  assert.deepEqual(
    (container?.Environment ?? []).map((v) => v.Name),
    ['WORK_ITEM_ID', 'VERIFIER', 'VERIFY_SHA', 'VERIFY_BRANCH', 'DEFAULT_BRANCH', 'REPOSITORY', 'BUNDLE_URL'],
  );
  assert.equal(run?.TimeoutSeconds, '{% $verifier.timeoutSeconds + 600 %}');
  // CollectVerifier is given the stopped task on a zero exit, and the error (whose cause holds it) otherwise.
  const payload = inner.CollectVerifier?.Arguments?.Payload;
  assert.ok(typeof payload === 'object');
  assert.equal(payload.task, '{% $verifierTask %}');
  assert.equal(payload.error, '{% $verifierError %}');
  assert.equal(run?.Assign?.verifierTask, '{% $states.result %}');
  assert.equal(inner.Verifier?.Assign?.verifierTask, null);
  // Substituted away by definition(); the template names the verifier's task definition and security group.
  const template = readFileSync(new URL('../../../templates/orchestration.yml', import.meta.url), 'utf8');
  assert.ok(template.includes('"TaskDefinition": "${VerifierTaskDefinitionArn}"'));
  assert.ok(template.includes('"SecurityGroups": ["${VerifierSecurityGroup}"]'));
});

test('the pull request and the review are given how Verify went', () => {
  for (const name of ['PrepareReview', 'OpenPullRequest']) {
    const payload = machine[name]?.Arguments?.Payload;
    assert.ok(typeof payload === 'object' && payload.verify === '{% $verify %}', `${name} is not given $verify`);
  }
});

test('a propose turn starts at Prepare like a change, and a proposal ends at Report with its own status (#169)', () => {
  const machine = definition().States;
  const route = machine.Route?.Choices ?? [];
  assert.deepEqual(route.map((c) => c.Next), ['Prepare']);
  assert.match(route[0]?.Condition ?? '', /\$intake\.route = 'change' or \$intake\.route = 'propose'/);
  assert.equal(machine.Route?.Default, 'NotAdmitted');
  const proposed = machine.HasChanges?.Choices?.[0];
  assert.equal(proposed?.Condition, '{% $collect.proposed = true %}');
  const report = machine.ReportProposed;
  assert.equal(report?.Resource, 'arn:aws:states:::lambda:invoke');
  assert.equal((report?.Arguments?.Payload as Record<string, unknown> | undefined)?.status, 'proposed');
  assert.equal(report?.Next, 'Proposed');
  assert.equal(machine.Proposed?.Type, 'Succeed');
});

test('a workflow change the target has not opted in to ends as workflow-change-refused, from Collect and from SaveWork', () => {
  for (const name of ['Collect', 'SaveWork']) {
    const catches = machine[name]?.Catch ?? [];
    const refused = catches.findIndex((c) => c.ErrorEquals.includes('WorkflowChangeRefused'));
    assert.ok(refused !== -1, `${name} does not catch WorkflowChangeRefused`);
    assert.ok(refused < catches.findIndex((c) => c.ErrorEquals.includes('States.ALL')), `${name} catches States.ALL first`);
    const catcher = catches[refused] as { Next?: string; Assign?: Record<string, unknown> };
    assert.equal(catcher.Next, 'ReportWorkflowChangeRefused');
    assert.ok(catcher.Assign && 'failure' in catcher.Assign, `${name} does not keep the failure for the report`);
  }
  const report = machine.ReportWorkflowChangeRefused;
  const payload = report?.Arguments?.Payload as Record<string, unknown> | undefined;
  assert.equal(payload?.status, 'workflow-change-refused');
  assert.equal(payload?.error, '{% $failure %}');
  assert.equal(report?.Next, 'WorkflowChangeRefused');
  assert.equal(machine.WorkflowChangeRefused?.Type, 'Fail');
});
