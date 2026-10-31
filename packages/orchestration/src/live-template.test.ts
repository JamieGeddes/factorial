/**
 * Checks on the live feed's wiring in templates/orchestration.yml (#194):
 * IAM is the only way in, only the invoker and the forwarder may publish,
 * nothing in the stack may subscribe, and the forwarder's two rules take
 * only what it forwards.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { matches, resource, resources, type Json } from './template-checks.ts';

const progress = JSON.parse(readFileSync(new URL('../../../contracts/progress/v1/examples/stage-started.json', import.meta.url), 'utf8')) as Json;
const workItem = JSON.parse(readFileSync(new URL('../../../contracts/workitem/v2/examples/github-issue.json', import.meta.url), 'utf8')) as Json;

test('the API and its namespace take IAM alone: no API key, no other provider', () => {
  const config = (resource('LiveApi').Properties as Json).EventConfig as Record<string, Array<{ AuthType: string }>>;
  for (const key of ['AuthProviders', 'ConnectionAuthModes', 'DefaultPublishAuthModes', 'DefaultSubscribeAuthModes']) {
    assert.deepEqual(config[key], [{ AuthType: 'AWS_IAM' }], key);
  }
  const namespace = resource('LiveNamespace').Properties as Json;
  assert.equal(namespace.Name, 'factorial');
  assert.deepEqual(namespace.PublishAuthModes, [{ AuthType: 'AWS_IAM' }]);
  assert.deepEqual(namespace.SubscribeAuthModes, [{ AuthType: 'AWS_IAM' }]);
  assert.ok(!Object.values(resources()).some((r) => r.Type === 'AWS::AppSync::ApiKey'));
});

test('publishing is the one AppSync action the stack grants, on the namespace, to the invoker and the forwarder', () => {
  const policy = (resource('LivePublishPolicy').Properties as Json).PolicyDocument as { Statement: Json[] };
  assert.deepEqual(policy.Statement, [{ Effect: 'Allow', Action: 'appsync:EventPublish', Resource: { 'Fn::GetAtt': 'LiveNamespace.ChannelNamespaceArn' } }]);
  const holders = Object.entries(resources())
    .filter(([, r]) => JSON.stringify(r).includes('{"Ref":"LivePublishPolicy"}'))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(holders, ['InvokerTaskRole', 'LiveForwardFunction']);
  const text = JSON.stringify(resources());
  for (const action of ['appsync:EventSubscribe', 'appsync:EventConnect', 'appsync:*']) assert.ok(!text.includes(action), action);
});

test('the forwarder holds the publish policy and nothing else', () => {
  const properties = resource('LiveForwardFunction').Properties as Json;
  assert.deepEqual(properties.Policies, [{ Ref: 'LivePublishPolicy' }]);
  assert.deepEqual(properties.Environment, { Variables: { LIVE_HTTP_DOMAIN: { 'Fn::GetAtt': 'LiveApi.Dns.Http' } } });
});

test('the execution rule is on the default bus and takes only this state machine', () => {
  const rule = resource('LiveExecutionRule').Properties as Json;
  assert.equal(rule.EventBusName, undefined);
  assert.deepEqual(rule.EventPattern, {
    source: ['aws.states'],
    'detail-type': ['Step Functions Execution Status Change'],
    detail: { stateMachineArn: [{ Ref: 'WorkStateMachine' }] },
  });
  assert.deepEqual(rule.Targets, [{ Id: 'live-forward', Arn: { Ref: 'LiveForwardFunction.Alias' } }]);
});

test('the progress rule takes every progress event and no work item', () => {
  const rule = resource('LiveProgressRule').Properties as { EventPattern: Json; EventBusName: unknown };
  assert.deepEqual(rule.EventBusName, { 'Fn::ImportValue': 'Factorial-WorkBusName' });
  assert.ok(matches(rule.EventPattern, { source: 'factorial.progress', 'detail-type': 'WorkItemProgress', detail: progress }));
  assert.ok(!matches(rule.EventPattern, { source: 'factorial.triggers', 'detail-type': 'WorkItem', detail: workItem }));
});

test('each rule may invoke the forwarder, and a failing notice is retried twice, then dropped', () => {
  for (const [permission, rule] of [
    ['LiveForwardExecutionPermission', 'LiveExecutionRule'],
    ['LiveForwardProgressPermission', 'LiveProgressRule'],
  ]) {
    const properties = resource(permission ?? '').Properties as Json;
    assert.deepEqual(properties.SourceArn, { 'Fn::GetAtt': `${rule}.Arn` });
    assert.deepEqual(properties.FunctionName, { Ref: 'LiveForwardFunction.Alias' });
  }
  const config = resource('LiveForwardInvokeConfig').Properties as Json;
  assert.equal(config.MaximumRetryAttempts, 2);
  assert.equal(config.MaximumEventAgeInSeconds, 300);
});

test('the invoker is told where to publish', () => {
  const [container] = ((resource('InvokerTaskDefinition').Properties as Json).ContainerDefinitions as Array<{ Environment: Array<{ Name: string; Value: unknown }> }>);
  const env = Object.fromEntries((container?.Environment ?? []).map((e) => [e.Name, e.Value]));
  assert.deepEqual(env.LIVE_HTTP_DOMAIN, { 'Fn::GetAtt': 'LiveApi.Dns.Http' });
  assert.deepEqual(env.LIVE_REGION, { Ref: 'AWS::Region' });
});
