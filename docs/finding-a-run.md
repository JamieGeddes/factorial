# Finding a run

Everything a run produces is keyed by its work item id: the Step Functions execution name, the harness session id, the ledger row key, the artefact prefix and the `workItemId` field on every log line. Start from the id; it is in the pull request body, the failure comment on the issue and the ledger.

All paths are in the AWS console, region **Europe (Ireland) eu-west-1**. Replace `<id>` with the work item id.

## 1. The ledger row

**DynamoDB** → left nav **Tables** → **Explore items** → table **factorial-work-items** → **Query**, partition key `workItemId` = `<id>` → **Run**.

Note `attempt`, `artefactPrefix`, `status` and, for a resumed or rework item, `resumedFrom` or `reworkOf.previousWorkItemId` (an earlier run, found the same way). A build that ran in more than one session has `buildRounds` and `buildSessionId`: round 1's builder session is the work item id, round *n*'s is `<id>-r<n>`.

## 2. The execution

**Step Functions** → left nav **State machines** → **factorial-work** → **Executions** tab → search box: `<id>` → open the execution.

Every state's output carries `workItemId` and `attempt`. **Plan**, **Build** and **Review** output `taskArn`; its last segment is the invoker task id for that run (the planner may run twice, shown by `planAttempt`).

The execution log, with full state inputs and outputs, is the log group `/aws/vendedlogs/states/factorial-work`.

## 3. Logs: invoker and Lambdas

**CloudWatch** → left nav **Logs** → **Logs Insights** → select the log groups:

- `/factorial/invoker`
- `/aws/lambda/factorial-prepare`
- `/aws/lambda/factorial-collect-plan`
- `/aws/lambda/factorial-collect`
- `/aws/lambda/factorial-dispatch-tests`
- `/aws/lambda/factorial-prepare-review`
- `/aws/lambda/factorial-collect-review`
- `/aws/lambda/factorial-open-pr`
- `/aws/lambda/factorial-report`

Set the time range to cover the run, then run:

```
fields @timestamp, stage, attempt, level, message, @log
| filter workItemId = "<id>"
| sort @timestamp asc
| limit 10000
```

Add `| filter level = "error"` to see only failures. The invoker's own stream is `invoker/invoker/<task id>` in `/factorial/invoker`.

## 4. The artefacts

**S3** → **Buckets** → `factorial-work-artefacts-<account id>` → open the folder `<id>/` → `<attempt>/` (the ledger's `artefactPrefix`).

It holds `workitem.json`, `prepare/`, `plan/` (the plan as markdown and JSON, its validation result, and the planner's transcript and usage), `build/` (transcript, usage, the agent's notes and logs, the git bundle; a round after the first under `build/round-<n>/`), `test/`, `review/` (what the reviewer was given, its transcript and usage, and `review.json` or `error.json`), `pr/` and `report.json`. A resumed item's artefacts are under its own id, with the next attempt number.

## 5. The AgentCore trace

The invoker sends the session id, which is the work item id (with `-r<n>` for a later build round), as `session.id` in the `baggage` header of the harness invocation, with `factorial.workItemId` and `factorial.attempt`.

**CloudWatch** → left nav **GenAI Observability** → **Bedrock AgentCore** → **Agents** tab → `factorial_builder` → **Sessions** tab → find session `<id>` → open a trace.

Traces appear only once CloudWatch Transaction Search is enabled for the account, which is not yet the case; enabling it belongs with the per-role metrics work. Until then the harness runtime logs (`/aws/bedrock-agentcore/runtimes/harness_factorial_builder-*-live`) are not keyed by session, and the transcript in the artefacts (`build/transcript.jsonl`) is the record of what the agent did.

A build on the builder runtime (`TARGET=runtime`, docs/agent-sdk-plan.md) is different: Factorial's host process writes its own structured lines, with `workItemId` and `attempt` from the invoker's payload, to `/aws/bedrock-agentcore/runtimes/factorial_builder-*-live` (run started, tool use denied, run ended). Its `build/usage.json` adds an `sdk` block with the SDK's cost estimate, per-model usage (subagents included) and how many times the invoker re-attached to the stream.
