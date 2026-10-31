/**
 * Checks on the notifier's wiring in templates/orchestration.yml (#219): the
 * rule routes only the event githubIssueNotifier acts on, and both kinds of
 * failed notice (function errors, delivery failures) reach one queue.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parse } from 'yaml';

type Json = Record<string, unknown>;

/** Resources of the template; CloudFormation short-form tags parse to `{ Tag: value }`. */
function resources(): Record<string, Json> {
  const tags = ['Ref', 'GetAtt', 'Sub', 'ImportValue', 'Join', 'Select', 'If', 'Equals', 'Not', 'And', 'Or', 'FindInMap', 'Split', 'GetAZs', 'Base64', 'Condition'].map((name) => ({
    tag: `!${name}`,
    resolve: (value: unknown) => ({ [name === 'Ref' || name === 'Condition' ? name : `Fn::${name}`]: value }),
  }));
  const template = parse(readFileSync(new URL('../../../templates/orchestration.yml', import.meta.url), 'utf8'), { customTags: tags }) as {
    Resources: Record<string, Json>;
  };
  return template.Resources;
}

/** One resource's definition; fails when it is missing. */
function resource(name: string): Json {
  const found = resources()[name];
  assert.ok(found, `${name} not found`);
  return found;
}

const rule = (): { EventPattern: Json; Targets: Array<Json> } => resource('ProgressNotifyRule').Properties as never;

/** EventBridge matching for the operators the rule uses: an array is any-of, `{ exists: false }` is absence, an object nests. */
function matches(pattern: Json, event: Json): boolean {
  return Object.entries(pattern).every(([key, expected]) => {
    const actual = event[key];
    if (Array.isArray(expected)) {
      return expected.some((item) => {
        if (item !== null && typeof item === 'object') {
          const { exists } = item as { exists?: boolean };
          assert.notEqual(exists, undefined, `unsupported operator in ${JSON.stringify(item)}`);
          return (actual !== undefined) === exists;
        }
        return item === actual;
      });
    }
    return actual !== null && typeof actual === 'object' && matches(expected as Json, actual as Json);
  });
}

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
