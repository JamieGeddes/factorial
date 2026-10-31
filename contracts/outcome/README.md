# Outcome

An `Outcome` event (source `factorial.outcome`, detail type `Outcome`) on the `factorial-work` bus says what the pipeline concluded about one turn (#165). Inputs arrive as a `WorkItem`; results leave as an `Outcome`, and a reporter for the item's source type tells the requester. The state machine knows nothing of where a result is told, so a new source (Jira, an alert, chat) needs a reporter and a rule, not a change to the state machine.

It is internal to Factorial, not part of the `WorkItem` API, but other components act on it (the reporters now; the dashboard and the retrospective later, `docs/design-plan.md` §3.5, §3.6), so it has a schema and is changed with the same care. The canonical definition is the JSON Schema in `v1/outcome.schema.json`; `@factorial/outcome` validates against that file, in the orchestrator before it is emitted and in each reporter before it is delivered.

## Who emits

Only the orchestrator, at every terminal state, through `emitOutcome` in `packages/orchestration/src/lib/outcome.ts`:

| Terminal state | Results |
|---|---|
| Intake (the `refuse` route) | `refused` |
| Report | `no-changes`, `tests-failed`, `invalid-plan`, `failed` |
| OpenPullRequest | `pr-opened`, `pr-updated` |

A duplicate WorkItem emits nothing: the first turn did. `emitOutcome` validates the outcome, writes `outcome/outcome.json` under the attempt's prefix, sets `result` on the ledger row and only then puts the event, so an outcome is recorded before anything delivers it. The functions that emit hold `events:PutEvents` for this source only (`factorial-outcome-events`); no agent role can put an event.

## Who delivers

One reporter per source type, each its own Lambda selected by an EventBridge rule on `detail.source.type`. `factorial-report-github` serves every `github-*` source (`packages/orchestration/src/reporters/github/`).

A reporter reads one artefact: the attempt's `report.json` (`lib/report-file.ts`), which every terminal state writes before it emits. Its `delivery` carries the facts the message is built from (the builder's summary, each rework point and its answer, the test and review facts, the saved branch), so each reporter words them its own way. The outcome itself carries pointers only.

Delivery never fails the turn: a reporter writes nothing but its own delivery record, and a failed delivery is retried from the event and then left on the reporter's failed-delivery queue with an alarm.

## Fields

| Field | Purpose |
|---|---|
| `schemaVersion` | Contract version. Always `1` for this schema. |
| `workItemId`, `attempt` | The turn's work item and its attempt: one outcome per work item. |
| `threadKey` | The thread, once Intake has found it. |
| `route` | The route Intake chose (`change`, `refuse`); absent when the turn ended before Intake chose one. |
| `source` | Copied from the WorkItem: where the request came from, and so which reporter delivers it. |
| `inReplyTo` | Copied from the WorkItem when present: the pull request the turn continued. |
| `repository` | Where the code lives. Not always where the request came from. |
| `result` | `pr-opened`, `pr-updated`, `no-changes`, `tests-failed`, `invalid-plan`, `failed` or `refused`. |
| `reason` | For `refused` only: `not-eligible`, `busy`, `rework-limit` or `covered-by-review`. |
| `at` | When the outcome was built. |
| `artefactPrefix` | `<workItemId>/<attempt>/`; its `report.json` carries what delivery needs. |
| `pullRequest` | The pull request opened or updated, or the one a rework turn continued. Required for `pr-opened` and `pr-updated`. |
| `branch` | The thread's branch, once known. Required for `pr-opened` and `pr-updated`. |
| `testedSha` | The commit the checks passed on, which is the branch head. On `pr-opened` and `pr-updated` only, and required there. |
| `savedWork` | Untested work pushed to the branch after a failed build: its `branch` and, when known, the work item's `commits`. Never on `pr-opened`, `pr-updated` or `refused`. |

`additionalProperties` is `false` at every level. Nothing in an outcome is content: no title, body, comment, summary or log.

## Delivery

At least once. A retried terminal state emits the same outcome again, and EventBridge may deliver an event more than once. A reporter delivers each outcome once: the GitHub reporter claims the delivery on the ledger row (`outcomeDelivery`) with a conditional write before posting and confirms it after; a failed attempt releases its claim, and a claim older than its lease can be taken over. An attempt that takes over checks the target for the hidden marker every outcome comment carries (`<!-- factorial:outcome <workItemId> -->`, by the App's bot user) before posting again.

## Change log

- **2026-10: v1.** One outcome per turn, from Intake, Report and OpenPullRequest, delivered by the GitHub reporter (#165).
