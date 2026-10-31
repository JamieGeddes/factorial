# Finding a run

Everything a run produces is keyed by its work item id: the Runtime session id, the ledger row key, the artefact prefix and the `workItemId` field on every log line and state output. The Step Functions execution is the exception: EventBridge starts it and names it, so its name is not the id, and the ledger row records its ARN instead (#203). Start from the id; it is in the pull request body, the failure comment on the issue and the ledger.

All paths are in the AWS console, region **Europe (Ireland) eu-west-1**. Replace `<id>` with the work item id.

## 1. The ledger row

**DynamoDB** → left nav **Tables** → **Explore items** → table **factorial-work-items** → **Query**, partition key `workItemId` = `<id>` → **Run**.

Note `attempt`, `artefactPrefix`, `executionArn`, `status`, `route`, `threadKey` and, for a resumed or rework item, `resumedFrom` or `reworkOf.previousWorkItemId` (an earlier run, found the same way). A build that ran in more than one session has a `Build#<n>` entry under `stages` for each later round, its session in `run.sessionId`: round 1's builder session is the work item id, round *n*'s is `<id>-r<n>`. Items accepted before #163 have no `route` or `threadKey`, and items accepted before #203 no `executionArn`.

**Stage timings.** `stages` holds one entry per stage that ran (`Build#2` for the second build round), each with `startedAt`, `endedAt`, `outcome` and any `error`; `stages.Build.run` and `stages.Review.run` summarise each agent run (Runtime version, model, effort, turns, tokens, cost estimate, record keys). `endedAt` on the row says when the item ended. Items accepted before #15 have no `stages`, and items that ended before its second part keep the run on interim fields instead: the builder's at the top level (`stopReason`, `toolCalls`, `usage`, `buildError`, `buildRounds`, `buildSessionId`, `build.usageKey`, ...) and the reviewer's under `review`. The same transitions went to the `factorial-work` bus as `WorkItemProgress` events (`contracts/progress/v1/`), and the Lambdas log `progress not recorded` when one could not be written.

**The thread.** Table **factorial-threads** → **Query**, partition key `threadKey` = the row's `threadKey` → **Run**: the branch, the pull request (`prNumber`, `prOpenedBy`) and, once it has closed, `outcome` (`merged` or `closed`, when, by whom and the merge commit; #204), the turn holding it (`inFlight`) and the automatic rework count. To list every turn on the thread: table **factorial-work-items** → **Query** → **Select a table or index**: `threadKey-createdAt-index`, partition key `threadKey` = the same value → **Run**. To start from a pull request instead: table **factorial-threads** → **Query** → index `pullRequestKey-index`, partition key `<owner>/<name>#<number>` in lower case → **Run**.

## 2. The execution

Open `https://eu-west-1.console.aws.amazon.com/states/home?region=eu-west-1#/v2/executions/details/<executionArn>` with the ledger row's `executionArn`, or run `aws stepfunctions describe-execution --execution-arn <executionArn>`.

For a row without `executionArn`, find it from the execution log: **CloudWatch** → left nav **Logs** → **Logs Insights** → log group `/aws/vendedlogs/states/factorial-work` → a time range covering the row's `createdAt` → query:

```
fields @timestamp, execution_arn
| filter type = "ExecutionStarted" and details.input like "<id>"
```

The execution name (`<uuid>_<uuid>`) is EventBridge's, so searching the **Executions** tab for the id finds nothing.

Every state's output carries `workItemId` and `attempt`. **Build** and **Review** output `taskArn`; its last segment is the invoker task id for that run. Runs before 2026-10-25's phase 3.1 also had **Plan** (twice when the first plan was rejected, shown by `planAttempt`) and **CollectPlan**.

The execution log, with full state inputs and outputs, is the log group `/aws/vendedlogs/states/factorial-work`.

## 3. Logs: invoker and Lambdas

**CloudWatch** → left nav **Logs** → **Logs Insights** → select the log groups:

- `/factorial/invoker`
- `/aws/lambda/factorial-intake`
- `/aws/lambda/factorial-prepare`
- `/aws/lambda/factorial-collect`
- `/aws/lambda/factorial-dispatch-tests`
- `/aws/lambda/factorial-prepare-review`
- `/aws/lambda/factorial-collect-review`
- `/aws/lambda/factorial-open-pr`
- `/aws/lambda/factorial-report`
- `/aws/lambda/factorial-report-github` (every comment, reply and review re-request on GitHub: the "started" notice on a labelled issue, whose ledger row's `startedNotifiedAt` says it was sent, and the turn's outcome, whose `outcomeDelivery.deliveredAt` says it was delivered)
- `/aws/lambda/factorial-thread-outcome` (the pull request's outcome on its thread; lines carry the id of the item that opened the pull request, and one the function ignored names the pull request, `<owner>/<name>#<number>`, instead)

Set the time range to cover the run, then run:

```
fields @timestamp, stage, attempt, level, message, @log
| filter workItemId = "<id>"
| sort @timestamp asc
| limit 10000
```

Add `| filter level = "error"` to see only failures. The invoker's own stream is `invoker/invoker/<task id>` in `/factorial/invoker`.

A delivery that failed (the reporter erred after its retries, or EventBridge could not deliver to it) is not in the log group alone: it is in the SQS queue `factorial-report-github-failed`, and the alarm `factorial-report-github-failed` is in `ALARM`. In the console go to **SQS** → **Queues** → `factorial-report-github-failed` → **Send and receive messages** → **Poll for messages**, then search the message bodies for the work item id. A body is the event (an `Outcome` or a `WorkItemProgress`), with no content. Messages are kept 14 days. Delivery is idempotent, so once the cause is fixed the event can be put on the bus again: **Amazon EventBridge** → left nav **Event buses** → `factorial-work` → **Send events**, with **Event source** `factorial.outcome` and **Detail type** `Outcome` for an outcome (`factorial.progress` and `WorkItemProgress` for a notice), and the message body's `detail` as **Event detail**. An outcome that failed to record is in `factorial-thread-outcome-failed` the same way, as the `PullRequestClosed` event: search for the pull request number.

## 4. The artefacts

**S3** → **Buckets** → `factorial-work-artefacts-<account id>` → open the folder `<id>/` → `<attempt>/` (the ledger's `artefactPrefix`).

It holds `workitem.json`, `intake/intake.json` (the thread and route Intake chose, and why), `prepare/`, `plan/` (the builder's plan as markdown and JSON and its validation result; before phase 3.1 also the planner's transcript and usage), `build/` (transcript, usage, the agent's notes and logs, the git bundle; a round after the first under `build/round-<n>/`), `test/`, `review/` (what the reviewer was given, its transcript and usage, and `review.json` or `error.json`), `pr/`, `report.json` (the outcome's reason and what the reporter's comment was built from) and `outcome/outcome.json` (the turn's `Outcome`, `contracts/outcome/v1/`, also on the ledger row as `result`). A resumed item's artefacts are under its own id, with the next attempt number. After #167, `test/` becomes `verify/<name>/result.json` with that verifier's logs beside it, and the `factorial-dispatch-tests` log group above goes with the dispatched workflow.

## 5. The AgentCore trace

The invoker sends the session id, which is the work item id (with `-r<n>` for a later build round), as `session.id` in the `baggage` header of each invocation, with `factorial.workItemId` and `factorial.attempt`.

**CloudWatch** → left nav **GenAI Observability** → **Bedrock AgentCore** → **Agents** tab → `factorial_builder` or `factorial_reviewer` (`factorial_planner` for runs before phase 3.1) → **Sessions** tab → find session `<id>` → open a trace.

Traces appear only once CloudWatch Transaction Search is enabled for the account, which is not yet the case; enabling it belongs with the per-role metrics work. Until then the transcripts in the artefacts (`build/`, which holds the plan subagent's run too, and `review/`) are the record of what each agent did.

The builder runs on a Runtime (`docs/pi-plan.md`): Factorial's host process writes its own structured lines, with `workItemId` and `attempt` from the invoker's payload, to `/aws/bedrock-agentcore/runtimes/factorial_builder-*-live` (run started, tool use denied, plan invalid, report incomplete, run ended). Its `build/transcript.jsonl` holds the run's events (`contracts/run/v1/`: model calls, text, tool calls and results, subagents, compaction, and any other harness messages as `harness` events), and its `build/usage.json` adds a `harness` block (`sdk` before 2026-10-28) with the harness and its version, the models by purpose, the harness's cost estimate, per-model usage (subagents included), a `subagents` entry (each `plan` or `explore` run in order, and a total per agent type: duration and tool calls from the SDK's Agent result; model calls and tokens summed from the subagent's own streamed calls, with output a lower bound (`outputTokensAtLeast`); and `finalContextTokens`, the SDK's `totalTokens`, which is the subagent's last call and not a total. Already inside the run's totals, with no dollar cost) and how many times the invoker re-attached to the stream. The reviewer runs on its own Runtime since phase 3.2, and its host writes the same lines to `/aws/bedrock-agentcore/runtimes/factorial_reviewer-*-live` (run started, tool use denied, reviewer sent back with the reason (an invalid review, or the second pass), run ended); its `review/usage.json` has the same `harness` block, with no subagents.
