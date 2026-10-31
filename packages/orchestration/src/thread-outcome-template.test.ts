/**
 * Checks on the thread outcome's wiring in templates/orchestration.yml
 * (#204): the rule routes only PullRequestClosed, the function's role holds
 * only what recording and announcing the outcome need, and both kinds of
 * failure (function errors, delivery failures) reach one queue.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { matches, resource, type Json } from './template-checks.ts';

const rule = (): { EventPattern: Json; Targets: Array<Json> } => resource('PullRequestClosedRule').Properties as never;
const closed = JSON.parse(readFileSync(new URL('../../../contracts/pull-request-closed/v1/examples/merged.json', import.meta.url), 'utf8')) as Json;
const workItem = JSON.parse(readFileSync(new URL('../../../contracts/workitem/v2/examples/github-issue.json', import.meta.url), 'utf8')) as Json;

test('the rule matches PullRequestClosed from the adapters and nothing else', () => {
  const { EventPattern } = rule();
  assert.ok(matches(EventPattern, { source: 'factorial.triggers', 'detail-type': 'PullRequestClosed', detail: closed }));
  assert.ok(!matches(EventPattern, { source: 'factorial.triggers', 'detail-type': 'WorkItem', detail: workItem }));
  assert.ok(!matches(EventPattern, { source: 'factorial.progress', 'detail-type': 'PullRequestClosed', detail: closed }));
});

test('the work item rule never starts work for a closed pull request', () => {
  const { EventPattern } = resource('WorkItemRule').Properties as { EventPattern: Json };
  assert.ok(!matches(EventPattern, { source: 'factorial.triggers', 'detail-type': 'PullRequestClosed', detail: closed }));
});

test("the function's role holds the thread index, the thread update, the ledger read, the queue and the progress events", () => {
  const properties = resource('ThreadOutcomeFunction').Properties as Json;
  const policies = properties.Policies as Array<Json>;
  const statements = policies.flatMap((policy) => (policy.Statement as Json[] | undefined) ?? []);
  assert.deepEqual(
    statements.map((statement) => [statement.Action, statement.Resource]),
    [
      ['dynamodb:Query', { 'Fn::Sub': '${ThreadsTable.Arn}/index/pullRequestKey-index' }],
      ['dynamodb:UpdateItem', { 'Fn::GetAtt': 'ThreadsTable.Arn' }],
      ['dynamodb:GetItem', { 'Fn::GetAtt': 'WorkItemsTable.Arn' }],
      ['sqs:SendMessage', { 'Fn::GetAtt': 'ThreadOutcomeFailedQueue.Arn' }],
    ],
  );
  assert.deepEqual(
    policies.filter((policy) => !policy.Statement),
    [{ Ref: 'ProgressEventsPolicy' }],
  );
});

test('function errors and delivery failures go to one queue, which only the rule may write to', () => {
  const config = resource('ThreadOutcomeFunctionInvokeConfig');
  assert.deepEqual(config.Properties, {
    FunctionName: { Ref: 'ThreadOutcomeFunction' },
    Qualifier: 'live',
    MaximumRetryAttempts: 2,
    MaximumEventAgeInSeconds: 3600,
    DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': 'ThreadOutcomeFailedQueue.Arn' } } },
  });
  const [target] = rule().Targets;
  assert.deepEqual(target?.DeadLetterConfig, { Arn: { 'Fn::GetAtt': 'ThreadOutcomeFailedQueue.Arn' } });
  const queue = resource('ThreadOutcomeFailedQueue').Properties as Json;
  assert.equal(queue.QueueName, 'factorial-thread-outcome-failed');
  assert.equal(queue.SqsManagedSseEnabled, true);
  const statements = ((resource('ThreadOutcomeFailedQueuePolicy').Properties as Json).PolicyDocument as { Statement: Json[] }).Statement;
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0]?.Condition, { ArnEquals: { 'aws:SourceArn': { 'Fn::GetAtt': 'PullRequestClosedRule.Arn' } } });
});
