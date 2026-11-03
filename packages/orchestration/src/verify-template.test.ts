/**
 * Checks on the Verify stage's resources (#167): the verifier task's role,
 * under which a target's untrusted checks run, can call no model and reach
 * none of Factorial's data; the task runs the agent image with the check
 * runner and a network that is egress only; the stage's Lambdas hold only what
 * their part needs; and nothing of the verifier Runtime or the test workflow
 * is left.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resource, resources, type Json } from './template-checks.ts';

const statements = (role: Json): Json[] =>
  ((role.Properties as { Policies?: Array<{ PolicyDocument: { Statement: Json[] } }> }).Policies ?? []).flatMap((p) => p.PolicyDocument.Statement);

const actions = (statement: Json): string[] => [statement.Action].flat() as string[];

test("the verifier task's role can call no model and read no bucket, table or secret: the npm mirror only", () => {
  const role = resources('agent').VerifierTaskRole as Json;
  assert.ok(role, 'VerifierTaskRole not found');
  const properties = role.Properties as Json;
  assert.equal(properties.RoleName, 'factorial-agent-verifier');
  assert.deepEqual(properties.PermissionsBoundary, { 'Fn::ImportValue': 'Factorial-AgentPermissionsBoundaryArn' });
  assert.equal(properties.ManagedPolicyArns, undefined);
  const trust = (properties.AssumeRolePolicyDocument as { Statement: Json[] }).Statement;
  assert.deepEqual(
    trust.map((s) => s.Principal),
    [{ Service: 'ecs-tasks.amazonaws.com' }],
  );
  const granted = statements(role).filter((s) => s.Effect === 'Allow').flatMap(actions).sort();
  assert.deepEqual(granted, ['codeartifact:GetAuthorizationToken', 'codeartifact:ReadFromRepository', 'sts:GetServiceBearerToken']);
});

test('the verifier task runs the agent image with the check runner, an init process and the npm mirror, logging to its own group', () => {
  const properties = resource('VerifierTaskDefinition').Properties as Json;
  assert.equal(properties.Family, 'factorial-verifier');
  assert.deepEqual(properties.TaskRoleArn, { 'Fn::ImportValue': 'Factorial-VerifierTaskRoleArn' });
  assert.deepEqual(properties.ExecutionRoleArn, { 'Fn::GetAtt': 'VerifierExecutionRole.Arn' });
  assert.equal(resource('VerifierTaskDefinition').DeletionPolicy, 'Retain');
  const [container, ...others] = properties.ContainerDefinitions as Json[];
  assert.equal(others.length, 0);
  assert.equal(container!.Name, 'verifier');
  assert.deepEqual(container!.EntryPoint, ['node', '/opt/factorial/agent-runtime/verify.mjs']);
  assert.ok(JSON.stringify(container!.Image).includes('Factorial-AgentRuntimeRepositoryUri'));
  assert.deepEqual(container!.LinuxParameters, { InitProcessEnabled: true });
  const env = Object.fromEntries((container!.Environment as Array<{ Name: string; Value: unknown }>).map((v) => [v.Name, v.Value]));
  assert.deepEqual(Object.keys(env).sort(), ['AWS_REGION', 'FACTORIAL_CODEARTIFACT_DOMAIN', 'FACTORIAL_CODEARTIFACT_DOMAIN_OWNER', 'FACTORIAL_CODEARTIFACT_REPOSITORY']);
  const logOptions = (container!.LogConfiguration as { Options: Json }).Options;
  assert.deepEqual(logOptions['awslogs-group'], { Ref: 'VerifierLogGroup' });
  assert.equal(logOptions['awslogs-stream-prefix'], 'verifier');
});

test("the verifier task's network takes nothing in, and its execution role only pulls the agent image and writes its log", () => {
  const group = resource('VerifierSecurityGroup').Properties as Json;
  assert.equal(group.SecurityGroupIngress, undefined);
  const granted = statements(resource('VerifierExecutionRole')).flatMap((s) => actions(s).map((a) => [a, JSON.stringify(s.Resource)]));
  for (const [action, on] of granted) {
    if (action!.startsWith('ecr:') && action !== 'ecr:GetAuthorizationToken') assert.match(on!, /repository\/factorial\/agent-runtime/);
    if (action!.startsWith('logs:')) assert.match(on!, /VerifierLogGroup/);
    assert.match(action!, /^(ecr|logs):/);
  }
});

test('the state machine may start the verifier task and pass its roles to ECS, and nothing else gets them', () => {
  const orchestrator = statements(resource('OrchestratorRole'));
  const run = orchestrator.find((s) => s.Sid === 'RunInvoker');
  assert.ok(JSON.stringify(run?.Resource).includes('task-definition/factorial-verifier:*'));
  const pass = orchestrator.find((s) => s.Sid === 'PassInvokerRoles');
  assert.ok(JSON.stringify(pass?.Resource).includes('Factorial-VerifierTaskRoleArn'));
  assert.ok(JSON.stringify(pass?.Resource).includes('VerifierExecutionRole'));
  const holders = Object.entries(resources())
    .filter(([name, d]) => name !== 'VerifierTaskDefinition' && name !== 'OrchestratorRole' && JSON.stringify(d).includes('Factorial-VerifierTaskRoleArn'))
    .map(([name]) => name);
  assert.deepEqual(holders, []);
});

test('CollectVerifier reads only the verifier log and reads no artefact, and PrepareVerify reads no artefact and commands no session', () => {
  const policies = (name: string): Json[] => ((resource(name).Properties as Json).Policies as Json[]).flatMap((p) => (p.Statement as Json[] | undefined) ?? []);
  const collect = policies('CollectVerifierFunction');
  assert.deepEqual(collect.filter((s) => actions(s).includes('s3:GetObject')), []);
  assert.deepEqual(collect.find((s) => s.Sid === 'ReadVerifierLogs')?.Resource, { 'Fn::Sub': '${VerifierLogGroup.Arn}:log-stream:verifier/verifier/*' });
  assert.deepEqual(policies('PrepareVerifyFunction').filter((s) => actions(s).some((a) => a.startsWith('s3:'))), []);
  for (const name of ['PrepareVerifyFunction', 'CollectVerifierFunction']) {
    const refs = JSON.stringify((resource(name).Properties as Json).Policies);
    assert.ok(!refs.includes('SessionCommandPolicy'), `${name} may command sessions`);
  }
});

test('nothing of the verifier Runtime, the invoker verify mode or the test workflow is left', () => {
  const agent = resources('agent');
  for (const gone of ['VerifierRuntime', 'VerifierRuntimeRole', 'VerifierRuntimeLiveEndpoint']) assert.equal(agent[gone], undefined, `${gone} is still in the agent template`);
  const all = resources();
  for (const gone of ['TestCallbackRole', 'DispatchTestsFunction', 'DispatchTestsLogGroup']) assert.equal(all[gone], undefined, `${gone} is still in the template`);
  assert.ok(!JSON.stringify(all).includes('VerifierRuntime'), 'the orchestration template still names the verifier Runtime');
  assert.equal(statements(resource('InvokerTaskRole')).find((s) => s.Sid === 'RunVerifiers'), undefined);
});
