# The progress record

Every stage a work item runs has one entry on its ledger row, under `stages`, and every transition is announced as a `WorkItemProgress` event (source `factorial.progress`) on the `factorial-work` bus (#15). Subscribers (the live feed's forwarder in #194, the GitHub reporter's started notice in #205 and #165, a dashboard) react to the events instead of polling the ledger.

It is internal to Factorial, not part of the `WorkItem` API, but other components act on it, so it has a schema and is changed with the same care. The canonical definition is the JSON Schema in `v1/progress-event.schema.json`; `@factorial/progress` validates every event against that file before it is put on the bus.

## Who emits

Only the orchestrator: its Lambdas (through `staged` in `packages/orchestration/src/lib/progress.ts`), the invoker (for Build and Review) and `factorial-thread-outcome` (for what became of the pull request, #204). Each transition is written to the ledger first and then put on the bus, by `ProgressRecorder` in `@factorial/progress`, so no stage can do one without the other. Their roles hold `events:PutEvents` on the bus only for this source (`factorial-progress-events`). No agent role can put an event: the agent permissions boundary allows no EventBridge action.

## Delivery

At least once. The ledger write is conditional, so a retried task records nothing twice, but it puts the event again, built from what the ledger holds, with the same `eventId`. A subscriber drops an `eventId` it has seen. Recording is best effort: a failed write or put is logged (`progress not recorded`) and never fails the stage.

## Fields

| Field | Purpose |
|---|---|
| `schemaVersion` | Contract version. Always `1` for this schema. |
| `eventId` | `<workItemId>:<stage key>:<transition>`; the same for every copy of a transition. |
| `workItemId`, `attempt` | The item and its attempt, as on the ledger row. |
| `threadKey` | The thread, once Intake has found it. |
| `source` | The WorkItem's `type` and `url`, so a subscriber can act per trigger type. |
| `repository` | The target repository. |
| `stage` | The state machine's state name (`Intake`, `Build`, `Test`, `ReportFailure`, ...), `WorkItem` for the item's end, or `PullRequest` for what became of the pull request it opened. |
| `round` | The build round, for `Build`, `SaveWork` and `ContinueBuild` after the first round. |
| `transition` | `started`, `succeeded` or `failed` for a stage; `ended` for the work item; `merged` or `closed` (without merging) for the pull request. |
| `at` | When the transition was recorded on the ledger. |
| `status` | On `ended` only: the ledger status the item ended with (`pr-opened`, `tests-failed`, `busy`, ...). |
| `error` | On `failed`: a name and a short, redacted message. |
| `pullRequest` | On `merged` and `closed` only: the pull request's `number`, who merged or closed it (`by`) and, for `merged`, the `mergeCommit`. |
| `run` | On the end of `Build` and `Review`: the agent run's metadata (role, Runtime version, harness, model, effort, session, tool calls, turns, duration, stop reason, outcome, usage, cost estimate, record keys). |

`additionalProperties` is `false` at every level. Nothing in an event is content: no transcript, prompt, comment body or file.

## The ledger entry

`stages.<key>` on the row holds `startedAt`, `endedAt`, `outcome` and, where they apply, `round`, `error` and `run`, the same values the events carry. The key is the stage name, with `#<round>` for a round stage after the first (`Build`, `Build#2`). The row's `endedAt` is set when the item ends. A stage whose start was never recorded (a task that did not start its invoker) has an entry with only its end; when the item ends, any stage still open is ended as failed.

## Change log

- **2026-10: v1.** Stage transitions and the work item's end (#15).
- **2026-10: v1, additive.** The pull request's outcome: stage `PullRequest`, transitions `merged` and `closed`, and `pullRequest` (#204). Its record is the thread's `outcome`, not a stage entry; `at` is when the pull request closed. A subscriber that switches on `transition` ignores the new values until it handles them.
