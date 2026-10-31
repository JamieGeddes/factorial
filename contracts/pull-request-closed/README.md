# Pull request closed

A `PullRequestClosed` event (source `factorial.triggers`) on the `factorial-work` bus says that a pull request Factorial opened was closed, merged or not (#204). Whether it was merged is the only signal of whether the work was accepted.

It is not a `WorkItem`: nothing is asked of Factorial, so it never reaches Intake or the state machine. A trigger adapter emits it as the fact the source system reported, and `factorial-thread-outcome` records it on the pull request's thread (`outcome` on the `factorial-threads` row) and announces it as a `WorkItemProgress` event (`contracts/progress/`).

It is internal to Factorial, not part of the `WorkItem` API, but other components act on it, so it has a schema and is changed with the same care. The canonical definition is the JSON Schema in `v1/pull-request-closed.schema.json`; `@factorial/pull-request-closed` validates against that file, in the adapter before the event is put and in the consumer before it is recorded.

## Who emits

The GitHub adapter (`packages/triggers-github-issues`), for a `pull_request` webhook with action `closed` on a pull request opened by `<slug>[bot]` from a `factorial/<id>` branch in the same repository. Every other `pull_request` action, and a closed pull request anyone else opened, is ignored and logged with the reason.

## Fields

| Field | Purpose |
|---|---|
| `schemaVersion` | Contract version. Always `1` for this schema. |
| `repository` | The repository: `provider`, `owner`, `name`. |
| `number`, `url` | The pull request. |
| `headBranch` | The branch it was opened from, a Factorial work branch: its thread's branch. |
| `merged` | Whether it was merged when it closed. |
| `closedAt` | When it closed. |
| `mergedAt`, `mergeCommit` | When merged only: when, and the commit the merge made on the base branch. |
| `by` | Who merged it, or who closed it without merging. |

`additionalProperties` is `false` at every level. Nothing in an event is content: no title, body or comment.

## Delivery

GitHub may deliver a webhook more than once. Every copy maps to the same detail, and recording it sets the same values, so a repeat changes nothing. A pull request that is reopened and closed again is recorded by its latest close.

## Change log

- **2026-10: v1.** Merged or closed without merging (#204).
