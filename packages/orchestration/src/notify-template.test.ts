/**
 * Checks on the notifier's wiring in templates/orchestration.yml (#219): the
 * rule routes only the event githubIssueNotifier acts on, and both kinds of
 * failed notice (function errors, delivery failures) reach one queue.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { matches, resource, type Json } from './template-checks.ts';

const rule = (): { EventPattern: Json; Targets: Array<Json> } => resource('ProgressNotifyRule').Properties as never;

const example = JSON.parse(readFileSync(new URL('../../../contracts/progress/v1/examples/stage-started.json', import.meta.url), 'utf8')) as Json;
const buildStarted = (): Json => ({ ...example, stage: 'Build' });
const envelope = (detail: Json): Json => ({ source: 'factorial.progress', 'detail-type': 'WorkItemProgress', detail });

test('the rule matches a round-1 Build start and nothing else', () => {
  const { EventPattern } = rule();
  assert.deepEqual(EventPattern.detail, { stage: ['Build'], transition: ['started'], round: [{ exists: false }] });
  assert.ok(matches(EventPattern, envelope(buildStarted())));
  assert.ok(!matches(EventPattern, envelope({ ...buildStarted(), round: 2 })));
  assert.ok(!matches(EventPattern, envelope({ ...buildStarted(), transition: 'succeeded' })));
  assert.ok(!matches(EventPattern, envelope({ ...buildStarted(), stage: 'Test' })));
  assert.ok(!matches(EventPattern, { ...envelope(buildStarted()), source: 'factorial.triggers' }));
});

test('function errors go to the failed-notice queue after two retries on the live alias', () => {
  const config = resource('NotifyFunctionInvokeConfig');
  assert.equal(config.Type, 'AWS::Lambda::EventInvokeConfig');
  assert.deepEqual(config.Properties, {
    FunctionName: { Ref: 'NotifyFunction' },
    Qualifier: 'live',
    MaximumRetryAttempts: 2,
    MaximumEventAgeInSeconds: 3600,
    DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': 'NotifyFailedQueue.Arn' } } },
  });
  const queue = resource('NotifyFailedQueue').Properties as Json;
  assert.equal(queue.QueueName, 'factorial-notify-failed');
  assert.equal(queue.SqsManagedSseEnabled, true);
  assert.equal(queue.MessageRetentionPeriod, 14 * 24 * 60 * 60);
});

test("the function's role may send to the queue and nothing else is new", () => {
  const policies = ((resource('NotifyFunction').Properties as Json).Policies as Array<Json>).flatMap((policy) => (policy.Statement as Json[] | undefined) ?? []);
  const sqs = policies.filter((statement) => String(statement.Action).startsWith('sqs:'));
  assert.deepEqual(sqs.map((statement) => [statement.Action, statement.Resource]), [['sqs:SendMessage', { 'Fn::GetAtt': 'NotifyFailedQueue.Arn' }]]);
});

test('delivery failures go to the same queue, which only the rule may write to', () => {
  const [target] = rule().Targets;
  assert.ok(target);
  assert.deepEqual(target.DeadLetterConfig, { Arn: { 'Fn::GetAtt': 'NotifyFailedQueue.Arn' } });
  const policy = resource('NotifyFailedQueuePolicy').Properties as Json;
  assert.deepEqual(policy.Queues, [{ Ref: 'NotifyFailedQueue' }]);
  const statements = (policy.PolicyDocument as { Statement: Json[] }).Statement;
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0], {
    Sid: 'RuleDeadLetters',
    Effect: 'Allow',
    Principal: { Service: 'events.amazonaws.com' },
    Action: 'sqs:SendMessage',
    Resource: { 'Fn::GetAtt': 'NotifyFailedQueue.Arn' },
    Condition: { ArnEquals: { 'aws:SourceArn': { 'Fn::GetAtt': 'ProgressNotifyRule.Arn' } } },
  });
});
