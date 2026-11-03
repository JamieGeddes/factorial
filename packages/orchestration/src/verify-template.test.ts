/**
 * Checks on the Verify stage's resources (#167): the verifier Runtime's
 * execution role, under which a target's untrusted checks run, can call no
 * model and reach none of Factorial's data; the stage's Lambdas and the
 * invoker hold only what their part needs; and the test workflow's callback
 * role is gone.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resource, resources, type Json } from './template-checks.ts';

const statements = (role: Json): Json[] =>
  ((role.Properties as { Policies?: Array<{ PolicyDocument: { Statement: Json[] } }> }).Policies ?? []).flatMap((p) => p.PolicyDocument.Statement);

const actions = (statement: Json): string[] => [statement.Action].flat() as string[];

test("the verifier Runtime's role can call no model and read no bucket, table or secret", () => {
  const agent = resources('agent');
  const role = agent.VerifierRuntimeRole as Json;
  assert.ok(role, 'VerifierRuntimeRole not found');
  const properties = role.Properties as Json;
  assert.equal(properties.RoleName, 'factorial-agent-verifier');
  assert.deepEqual(properties.PermissionsBoundary, { 'Fn::ImportValue': 'Factorial-AgentPermissionsBoundaryArn' });
  // Its own statements, and the shared runtime policy every role carries.
  const shared = ((agent.AgentRuntimePolicy as Json).Properties as { PolicyDocument: { Statement: Json[] } }).PolicyDocument.Statement;
  assert.deepEqual(properties.ManagedPolicyArns, [{ Ref: 'AgentRuntimePolicy' }]);
  const granted = [...statements(role), ...shared].filter((s) => s.Effect === 'Allow').flatMap(actions);
  for (const action of granted) {
    assert.doesNotMatch(action, /^(bedrock|s3|dynamodb|secretsmanager|ssm|events|states|appsync|sts:AssumeRole$)/i, `${action} is granted to the verifier`);
  }
  assert.ok(!granted.includes('bedrock-agentcore:InvokeGateway'), 'the verifier reaches a gateway');
});

test('the verifier Runtime runs no model and names the npm mirror, and its live endpoint is promoted like the roles', () => {
  const agent = resources('agent');
  const runtime = (agent.VerifierRuntime as Json).Properties as Json;
  assert.equal(runtime.AgentRuntimeName, 'factorial_verifier');
  const env = runtime.EnvironmentVariables as Json;
  assert.equal(env.FACTORIAL_ROLE, 'verifier');
  assert.deepEqual(Object.keys(env).filter((name) => /MODEL|GATEWAY|MAX_/.test(name)), []);
  assert.ok(env.FACTORIAL_CODEARTIFACT_DOMAIN && env.FACTORIAL_CODEARTIFACT_REPOSITORY);
  assert.equal(((agent.VerifierRuntimeLiveEndpoint as Json).Properties as Json).Name, 'live');
});

test('CollectVerifier reads back only verifier results, and PrepareVerify reads no artefact', () => {
  const policies = (name: string): Json[] => ((resource(name).Properties as Json).Policies as Json[]).flatMap((p) => (p.Statement as Json[] | undefined) ?? []);
  const reads = policies('CollectVerifierFunction').filter((s) => actions(s).includes('s3:GetObject'));
  assert.deepEqual(reads.map((s) => s.Resource), [{ 'Fn::Sub': '${WorkArtefactsBucket.Arn}/*/verify/*/result.json' }]);
  assert.deepEqual(policies('PrepareVerifyFunction').filter((s) => actions(s).some((a) => a.startsWith('s3:'))), []);
});

test('the invoker may command and stop verifier sessions, and nothing of the test workflow is left', () => {
  const invoker = statements(resource('InvokerTaskRole')).find((s) => s.Sid === 'RunVerifiers');
  assert.deepEqual(actions(invoker ?? {}), ['bedrock-agentcore:InvokeAgentRuntimeCommand', 'bedrock-agentcore:StopRuntimeSession']);
  const all = resources();
  for (const gone of ['TestCallbackRole', 'DispatchTestsFunction', 'DispatchTestsLogGroup']) assert.equal(all[gone], undefined, `${gone} is still in the template`);
});
