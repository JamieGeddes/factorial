# The intake record

The intake record is what Intake decided about one `WorkItem` (#163): the thread it belongs to and the route it takes through the fixed stage graph. Intake writes it to `<workItemId>/<attempt>/intake/intake.json` and the state machine's Route choice acts on its `route`.

It is internal to Factorial, not part of the `WorkItem` API, but the orchestrator acts on it, so it has a schema and is changed with the same care. The canonical definition is the JSON Schema in `v1/intake.schema.json`; `packages/orchestration/src/lib/intake-record.ts` validates against that file before the record is stored or returned.

## Fields

| Field | Purpose |
|---|---|
| `schemaVersion` | Contract version. Always `1` for this schema. |
| `workItemId` | The item decided on. |
| `route` | `change` (the stages run as for any change), `propose` (the builder plans and changes nothing; the plan is posted for approval) or `refuse` (nothing runs). |
| `turn` | `new` (a new request), `resume` (a new attempt at a request whose earlier attempt saved work), `rework` (a turn on a pull request Factorial opened) or `approve` (the approval of a proposed plan, built on the proposal's thread). |
| `reason` | Why this route, in a sentence. |
| `threadKey`, `branch` | The thread, `<owner>/<name>#<branch>`, and its branch. Absent only when the item was refused before its thread was found. |
| `pullRequest`, `cause`, `previousWorkItemId` | For a `rework` turn: the pull request, why it needs rework (derived from what happened) and the item that opened it, from the thread. |
| `resumedFrom` | For a `resume` turn, the attempt it continues. |
| `approves` | For an `approve` turn, the proposal whose stored plan the build follows. |
| `refusal` | For `refuse`: the ledger `status` (`not-eligible`, `busy`, `rework-limit`, `covered-by-review`) and whether the refusal is answered on the pull request (`replied`; the GitHub reporter posts it from the refused outcome, `contracts/outcome/`). |

`additionalProperties` is `false` at every level.

## Routes

The route enum is short and fixed: a route is which stages run, not a different graph, and no agent chooses it (`docs/design-extension-points.md` §3.3, §4). New routes are added here with the states that serve them: #169 added `propose`; #161 adds `answer` and `ignore`, #168 adds `integrate`.

`propose` is chosen for an issue labelled with the plan label (source type `github-issue-plan`). The trigger label on the same issue, while the newest turn on its newest thread is a proposal that ended `proposed`, is an `approve` turn on the `change` route, on the proposal's thread and branch, seeded with the proposal's stored plan.

## Change log

- **2026-10: v1.** `change` and `refuse`, for new requests, resumed attempts and turns on pull requests (#163).
- **2026-11: v1, additive.** Route `propose`, turn `approve` and `approves`, for plans proposed for approval (#169).
- **2026-10: v1, wording.** `refusal.replied` says an answer is due rather than that Intake posted it: the GitHub reporter posts it from the refused outcome (#165). Same values, same field.
