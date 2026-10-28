# Finding a run

Everything a run produces is keyed by its work item id: the Step Functions execution name, the Runtime session id, the ledger row key, the artefact prefix and the `workItemId` field on every log line. Start from the id; it is in the pull request body, the failure comment on the issue and the ledger.

All paths are in the AWS console, region **Europe (Ireland) eu-west-1**. Replace `<id>` with the work item id.

## 1. The ledger row

**DynamoDB** → left nav **Tables** → **Explore items** → table **factorial-work-items** → **Query**, partition key `workItemId` = `<id>` → **Run**.

Note `attempt`, `artefactPrefix`, `status`, `route`, `threadKey` and, for a resumed or rework item, `resumedFrom` or `reworkOf.previousWorkItemId` (an earlier run, found the same way). A build that ran in more than one session has `buildRounds` and `buildSessionId`: round 1's builder session is the work item id, round *n*'s is `<id>-r<n>`. Items accepted before #163 have no `route` or `threadKey`.

**The thread.** Table **factorial-threads** → **Query**, partition key `threadKey` = the row's `threadKey` → **Run**: the branch, the pull request (`prNumber`, `prOpenedBy`), the turn holding it (`inFlight`) and the automatic rework count. To list every turn on the thread: table **factorial-work-items** → **Query** → **Select a table or index**: `threadKey-createdAt-index`, partition key `threadKey` = the same value → **Run**. To start from a pull request instead: table **factorial-threads** → **Query** → index `pullRequestKey-index`, partition key `<owner>/<name>#<number>` in lower case → **Run**.

## 2. The execution

**Step Functions** → left nav **State machines** → **factorial-work** → **Executions** tab → search box: `<id>` → open the execution.

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

It holds `workitem.json`, `intake/intake.json` (the thread and route Intake chose, and why), `prepare/`, `plan/` (the builder's plan as markdown and JSON and its validation result; before phase 3.1 also the planner's transcript and usage), `build/` (transcript, usage, the agent's notes and logs, the git bundle; a round after the first under `build/round-<n>/`), `test/`, `review/` (what the reviewer was given, its transcript and usage, and `review.json` or `error.json`), `pr/` and `report.json`. A resumed item's artefacts are under its own id, with the next attempt number. After #167, `test/` becomes `verify/<name>/result.json` with that verifier's logs beside it, and the `factorial-dispatch-tests` log group above goes with the dispatched workflow.

## 5. The AgentCore trace

The invoker sends the session id, which is the work item id (with `-r<n>` for a later build round), as `session.id` in the `baggage` header of each invocation, with `factorial.workItemId` and `factorial.attempt`.

**CloudWatch** → left nav **GenAI Observability** → **Bedrock AgentCore** → **Agents** tab → `factorial_builder` or `factorial_reviewer` (`factorial_planner` for runs before phase 3.1) → **Sessions** tab → find session `<id>` → open a trace.

Traces appear only once CloudWatch Transaction Search is enabled for the account, which is not yet the case; enabling it belongs with the per-role metrics work. Until then the transcripts in the artefacts (`build/`, which holds the plan subagent's run too, and `review/`) are the record of what each agent did.

The builder runs on a Runtime (`docs/agent-sdk-plan.md`): Factorial's host process writes its own structured lines, with `workItemId` and `attempt` from the invoker's payload, to `/aws/bedrock-agentcore/runtimes/factorial_builder-*-live` (run started, tool use denied, plan invalid, report incomplete, run ended). Its `build/transcript.jsonl` holds the run's events (`contracts/run/v1/`: model calls, text, tool calls and results, subagents, compaction, and the SDK's other messages as `harness` events), and its `build/usage.json` adds a `harness` block (`sdk` before 2026-10-28) with the harness and its version, the models by purpose, the harness's cost estimate, per-model usage (subagents included), a `subagents` entry (each `plan` or `explore` run in order, and a total per agent type: duration and tool calls from the SDK's Agent result; model calls and tokens summed from the subagent's own streamed calls, with output a lower bound (`outputTokensAtLeast`); and `finalContextTokens`, the SDK's `totalTokens`, which is the subagent's last call and not a total. Already inside the run's totals, with no dollar cost) and how many times the invoker re-attached to the stream. The reviewer runs on its own Runtime since phase 3.2, and its host writes the same lines to `/aws/bedrock-agentcore/runtimes/factorial_reviewer-*-live` (run started, tool use denied, reviewer sent back with the reason (an invalid review, or the second pass), run ended); its `review/usage.json` has the same `harness` block, with no subagents.
