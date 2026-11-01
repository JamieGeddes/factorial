/**
 * Checks on the thread reconciler's wiring in templates/orchestration.yml
 * (#237): an hourly schedule on its live alias, a role that holds only what
 * finding threads, recording an outcome, announcing it and counting it need,
 * and alarms named factorial-* that the command centre picks up.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { METRIC_NAMESPACE, MISSED_CLOSES_METRIC } from './lib/thread-reconcile.ts';
import { resource, type Json } from './template-checks.ts';

test('the schedule runs the live alias hourly', () => {
  const rule = resource('ThreadReconcileSchedule').Properties as Json;
  assert.equal(rule.ScheduleExpression, 'rate(1 hour)');
  assert.equal(rule.EventBusName, undefined);
  assert.deepEqual(rule.Targets, [{ Id: 'thread-reconcile', Arn: { Ref: 'ThreadReconcileFunction.Alias' } }]);
  const permission = resource('ThreadReconcileSchedulePermission').Properties as Json;
  assert.deepEqual(permission.FunctionName, { Ref: 'ThreadReconcileFunction.Alias' });
  assert.deepEqual(permission.SourceArn, { 'Fn::GetAtt': 'ThreadReconcileSchedule.Arn' });
});

test("the function's role scans threads, records and announces outcomes, reads GitHub and puts only Factorial metrics", () => {
  const properties = resource('ThreadReconcileFunction').Properties as Json;
  const policies = properties.Policies as Array<Json>;
  const statements = policies.flatMap((policy) => (policy.Statement as Json[] | undefined) ?? []);
  assert.deepEqual(
    statements.map((statement) => [statement.Action, statement.Resource]),
    [
      ['dynamodb:Scan', { 'Fn::GetAtt': 'ThreadsTable.Arn' }],
      ['dynamodb:Query', { 'Fn::Sub': '${ThreadsTable.Arn}/index/pullRequestKey-index' }],
      ['dynamodb:UpdateItem', { 'Fn::GetAtt': 'ThreadsTable.Arn' }],
      ['dynamodb:GetItem', { 'Fn::GetAtt': 'WorkItemsTable.Arn' }],
      ['cloudwatch:PutMetricData', '*'],
    ],
  );
  assert.deepEqual(statements.at(-1)?.Condition, { StringEquals: { 'cloudwatch:namespace': METRIC_NAMESPACE } });
  assert.deepEqual(
    policies.filter((policy) => !policy.Statement),
    [{ Ref: 'GitHubAppPolicy' }, { Ref: 'ProgressEventsPolicy' }],
  );
});

test('a failed run is not retried: the next hour is the retry', () => {
  const config = resource('ThreadReconcileFunctionInvokeConfig').Properties as Json;
  assert.equal(config.Qualifier, 'live');
  assert.equal(config.MaximumRetryAttempts, 0);
});

test('any missed close raises an alarm the command centre shows, pointing at the App settings', () => {
  const alarm = resource('MissedPullRequestClosesAlarm').Properties as Json;
  assert.equal(alarm.AlarmName, 'factorial-missed-pull-request-closes');
  assert.equal(alarm.Namespace, METRIC_NAMESPACE);
  assert.equal(alarm.MetricName, MISSED_CLOSES_METRIC);
  // The datapoint in all, without the repository dimension.
  assert.equal(alarm.Dimensions, undefined);
  assert.deepEqual([alarm.Statistic, alarm.Threshold, alarm.ComparisonOperator], ['Sum', 1, 'GreaterThanOrEqualToThreshold']);
  assert.match(String(alarm.AlarmDescription), /Subscribe to events/);
  assert.match(String(alarm.AlarmDescription), /Recent Deliveries/);
});

test("the reconciler's own failures alarm", () => {
  const alarm = resource('ThreadReconcileErrorsAlarm').Properties as Json;
  assert.equal(alarm.AlarmName, 'factorial-thread-reconcile-errors');
  assert.deepEqual(alarm.Dimensions, [{ Name: 'FunctionName', Value: 'factorial-thread-reconcile' }]);
});
