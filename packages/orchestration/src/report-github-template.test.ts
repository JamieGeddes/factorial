/**
 * Checks on the GitHub reporter's wiring in templates/orchestration.yml
 * (#165, #219): its rules route only outcomes and started notices from
 * GitHub sources, both kinds of failed delivery (function errors, delivery
 * failures) reach one queue with an alarm on it, and the reporter reads only
 * report.json of the artefact store. Outcomes come only from the terminal
 * states, which no longer speak to GitHub themselves.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { matches, resource, resources, type Json } from './template-checks.ts';

type Rule = { EventPattern: Json; Targets: Array<Json> };
const rule = (name: string): Rule => resource(name).Properties as never;

const progressExample = JSON.parse(readFileSync(new URL('../../../contracts/progress/v1/examples/stage-started.json', import.meta.url), 'utf8')) as Json;
const outcomeExample = JSON.parse(readFileSync(new URL('../../../contracts/outcome/v1/examples/pr-opened.json', import.meta.url), 'utf8')) as Json;
const buildStarted = (): Json => ({ ...progressExample, stage: 'Build' });
const envelope = (source: string, detailType: string, detail: Json): Json => ({ source, 'detail-type': detailType, detail });
const progress = (detail: Json): Json => envelope('factorial.progress', 'WorkItemProgress', detail);
const outcome = (detail: Json): Json => envelope('factorial.outcome', 'Outcome', detail);

const statements = (name: string): Json[] =>
  ((resource(name).Properties as Json).Policies as Array<Json>).flatMap((policy) => (policy.Statement as Json[] | undefined) ?? []);
const managed = (name: string): unknown[] => ((resource(name).Properties as Json).Policies as Array<unknown>).filter((policy) => !(policy as Json).Statement);

test('the outcome rule matches every outcome from a GitHub source and nothing else', () => {
  const { EventPattern } = rule('ReportGitHubOutcomeRule');
  assert.ok(matches(EventPattern, outcome(outcomeExample)));
  assert.ok(matches(EventPattern, outcome({ ...outcomeExample, source: { type: 'github-pull-request-review', id: '1', url: 'https://x' } })));
  assert.ok(!matches(EventPattern, outcome({ ...outcomeExample, source: { type: 'jira-issue', id: 'X-1', url: 'https://x' } })));
  assert.ok(!matches(EventPattern, envelope('factorial.progress', 'Outcome', outcomeExample)));
  assert.ok(!matches(EventPattern, envelope('factorial.outcome', 'WorkItemProgress', outcomeExample)));
});

test('the progress rule matches a round-1 Build start from a GitHub source and nothing else', () => {
  const { EventPattern } = rule('ReportGitHubProgressRule');
  assert.ok(matches(EventPattern, progress(buildStarted())));
  assert.ok(!matches(EventPattern, progress({ ...buildStarted(), round: 2 })));
  assert.ok(!matches(EventPattern, progress({ ...buildStarted(), transition: 'succeeded' })));
  assert.ok(!matches(EventPattern, progress({ ...buildStarted(), stage: 'Test' })));
  assert.ok(!matches(EventPattern, progress({ ...buildStarted(), source: { type: 'jira-issue', url: 'https://x' } })));
  assert.ok(!matches(EventPattern, { ...progress(buildStarted()), source: 'factorial.triggers' }));
});

test('both rules target the live alias, with failed deliveries going to one queue', () => {
  for (const name of ['ReportGitHubOutcomeRule', 'ReportGitHubProgressRule']) {
    const [target] = rule(name).Targets;
    assert.ok(target, name);
    assert.deepEqual(target.Arn, { Ref: 'ReportGitHubFunction.Alias' }, name);
    assert.deepEqual(target.DeadLetterConfig, { Arn: { 'Fn::GetAtt': 'ReportGitHubFailedQueue.Arn' } }, name);
    const permission = resource(`${name}Permission`).Properties as Json;
    assert.deepEqual(permission.SourceArn, { 'Fn::GetAtt': `${name}.Arn` }, name);
  }
});

test('function errors go to the failed-delivery queue after two retries on the live alias', () => {
  const config = resource('ReportGitHubFunctionInvokeConfig');
  assert.equal(config.Type, 'AWS::Lambda::EventInvokeConfig');
  assert.deepEqual(config.Properties, {
    FunctionName: { Ref: 'ReportGitHubFunction' },
    Qualifier: 'live',
    MaximumRetryAttempts: 2,
    MaximumEventAgeInSeconds: 3600,
    DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': 'ReportGitHubFailedQueue.Arn' } } },
  });
  const queue = resource('ReportGitHubFailedQueue').Properties as Json;
  assert.equal(queue.QueueName, 'factorial-report-github-failed');
  assert.equal(queue.SqsManagedSseEnabled, true);
  assert.equal(queue.MessageRetentionPeriod, 14 * 24 * 60 * 60);
});

test('only the two rules may write to the queue, and a message on it raises the alarm', () => {
  const policy = resource('ReportGitHubFailedQueuePolicy').Properties as Json;
  assert.deepEqual(policy.Queues, [{ Ref: 'ReportGitHubFailedQueue' }]);
  const [statement, ...rest] = (policy.PolicyDocument as { Statement: Json[] }).Statement;
  assert.equal(rest.length, 0);
  assert.deepEqual(statement, {
    Sid: 'RuleDeadLetters',
    Effect: 'Allow',
    Principal: { Service: 'events.amazonaws.com' },
    Action: 'sqs:SendMessage',
    Resource: { 'Fn::GetAtt': 'ReportGitHubFailedQueue.Arn' },
    Condition: { ArnEquals: { 'aws:SourceArn': [{ 'Fn::GetAtt': 'ReportGitHubOutcomeRule.Arn' }, { 'Fn::GetAtt': 'ReportGitHubProgressRule.Arn' }] } },
  });
  const alarm = resource('ReportGitHubFailedAlarm').Properties as Json;
  assert.equal(alarm.AlarmName, 'factorial-report-github-failed');
  assert.deepEqual(alarm.Dimensions, [{ Name: 'QueueName', Value: { 'Fn::GetAtt': 'ReportGitHubFailedQueue.QueueName' } }]);
  assert.equal(alarm.Threshold, 1);
});

test("the reporter's role reads only report.json, writes only the ledger and the queue, and puts no event", () => {
  const own = statements('ReportGitHubFunction').map((s) => [s.Action, s.Resource]);
  assert.deepEqual(own, [
    ['dynamodb:UpdateItem', { 'Fn::GetAtt': 'WorkItemsTable.Arn' }],
    ['s3:GetObject', { 'Fn::Sub': '${WorkArtefactsBucket.Arn}/*/report.json' }],
    ['sqs:SendMessage', { 'Fn::GetAtt': 'ReportGitHubFailedQueue.Arn' }],
  ]);
  assert.deepEqual(managed('ReportGitHubFunction'), [{ Ref: 'GitHubAppPolicy' }]);
});

test('only the terminal states may put outcomes, and Report no longer reaches GitHub', () => {
  const policy = (resource('OutcomeEventsPolicy').Properties as Json).PolicyDocument as { Statement: Json[] };
  assert.deepEqual(policy.Statement[0]?.Condition, { StringEquals: { 'events:source': 'factorial.outcome' } });
  const holders = Object.entries(resources())
    .filter(([, r]) => r.Type === 'AWS::Serverless::Function')
    .filter(([, r]) => ((r.Properties as Json).Policies as unknown[] | undefined)?.some((p) => (p as Json).Ref === 'OutcomeEventsPolicy'))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(holders, ['IntakeFunction', 'OpenPullRequestFunction', 'ReportFunction']);
  assert.ok(!managed('ReportFunction').some((p) => (p as Json).Ref === 'GitHubAppPolicy'));
});
