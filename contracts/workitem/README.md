# The `WorkItem` contract

`WorkItem` is Factorial's API. Every trigger adapter converts its input into exactly one `WorkItem` and places it on the Factorial event bus. Everything downstream (Step Functions, the agent, the PR stage) consumes only this shape and knows nothing about where the work came from.

The canonical definition is the JSON Schema in `v2/workitem.schema.json`. The TypeScript package `@factorial/workitem` validates against that file; it does not define the contract. It still reads `v1` items, against `v1/workitem.schema.json`, until those emitted before the adapters moved to `v2` have drained (see the change log).

## Event envelope

A `WorkItem` travels as the `detail` of an EventBridge event:

| Envelope field | Value |
|---|---|
| `source` | `factorial.triggers` |
| `detail-type` | `WorkItem` |
| `detail` | A `WorkItem` as defined by the schema |

The single Stage 0 rule matches on `source` and `detail-type` and starts the state machine.

## Fields

| Field | Purpose |
|---|---|
| `schemaVersion` | Contract version. Always `2` for this schema. |
| `id` | UUID assigned by the adapter. The correlation key: session id, ledger key, artefact prefix and a field on every log line. Not the Step Functions execution name, which EventBridge assigns; the ledger row records the execution's ARN. |
| `source.type` | Trigger type, kebab-case, e.g. `github-issue`. New triggers add a value; nothing else changes. |
| `source.id` | Identifier of the record within the source system: an issue number, or the id of a review, comment or workflow run. |
| `source.url` | Link back to the originating record. |
| `repository` | Provider, owner and name of the target repository. |
| `title`, `body` | The work, as the requester wrote it. |
| `requestedBy` | Requester identity in the source system. |
| `createdAt` | When the adapter created the `WorkItem`. |
| `group` | Optional. The set of items one trigger produced: `id` (UUID, shared by the set), `size` (at least 1) and `index` (1 to `size`). `size` lets a consumer tell when the set is complete. The validator also checks `index` ≤ `size`, which JSON Schema cannot express. |
| `parentId` | Optional. The `id` of the `WorkItem` whose Plan stage emitted this one. |
| `inReplyTo` | Optional. What the item continues, e.g. the pull request a review or comment was made on. Absent for a new request. See Continuity. |

## Continuity

`inReplyTo` says what an item continues, and nothing more. An adapter records the facts of the event: `source.type` says what happened (a review, an inline comment, a conversation comment, a failed workflow run), `source.id` and `source.url` point at it, `body` holds what was said and `requestedBy` who said it. The pipeline's Intake step resolves the thread from `inReplyTo`, fetches what the event did not carry and decides what the item means, so a new kind of turn needs no contract change.

- **`kind: "pull-request"`** with the pull request's `number` in `repository`. The only kind today; new kinds add a `kind` const.

The pull request source types, each with `source.id` the record's own id:

| `source.type` | The event |
|---|---|
| `github-pull-request-review` | A review submitted on the pull request |
| `github-pull-request-review-comment` | An inline comment on its diff |
| `github-pull-request-comment` | A comment in its conversation |
| `github-workflow-run` | A workflow run that completed on its head |

The GitHub adapter emits these since #163's third step. Before it, it emitted `github-pull-request` (with `source.id` the pull request number) and a rework `context`, which `v2` removed.


## One repository per WorkItem

A `WorkItem` is one unit of work for the pipeline: one repository, one branch, one pull request.

A trigger that applies to several repositories produces one `WorkItem` per repository. Fan-out happens before the pipeline: in the adapter when the repository list comes from configuration, or in a future intake step when the list has to be worked out.

`repository` stays a single object. Turning it into a list is a breaking change and is not planned.

The items from one trigger are linked by `group`, so results can be reported back to the source as a set.

## Lineage

`group` and `parentId` record where an item came from; neither changes how it is handled.

- **`group`**: the items one trigger produced, for example one per repository. Siblings share `group.id`; `size` and `index` say how many there are and which this is.
- **`parentId`**: the item whose Plan stage split its work into this one.
- **Rework** is a different relationship (same branch, same pull request): a turn in a thread, which `inReplyTo` names (see Continuity).

The ledger copies these onto the item's row as `groupId`, `groupSize`, `groupIndex` and `parentId`, so a group's or a parent's items can be listed.

Coordinated changes that must merge in order across repositories are out of scope. If they are needed, they would be expressed as dependencies between items, not as a multi-repository item.

## What is deliberately left out

- **The Factorial version that handled the work.** That is a property of the execution, not the request. The state machine records it in its output and the PR body.
- **Priority, labels, assignees.** Not needed to close the Stage 0 loop. Add them when a stage needs them.
- **Free-form metadata.** `additionalProperties` is `false` at every level, so unknown fields are rejected at the edge rather than silently carried through.
- **Multiple target repositories.** See One repository per WorkItem.

## Changing the contract

Changing this schema is a deliberate, human-approved decision, never a side effect of other work.

1. Open a PR that changes only the contract and its validator, with the label `contract-change`.
2. **Additive, optional fields** stay in `v1`. Because the schema is strict, in-flight executions on the previous version would reject the new field, so the PR also carries the `requires-drain` label and deployment waits for in-flight executions to finish before promoting.
3. **Breaking changes** (removing or renaming a field, changing a type, tightening a constraint) create `v2/` alongside `v1/` and increment `schemaVersion`. Adapters and consumers move together.
4. Update the examples and the tests in `packages/workitem` in the same PR.

## Change log

- **2026-10: v2, removed `context`.** Breaking, so a new version: `v2/` beside `v1/`, `schemaVersion` 2. `inReplyTo` replaced `context` in #163: nothing has set it since the adapter moved to facts, and Intake refuses an item that carries it. `v2` is otherwise `v1` unchanged. Shipped in three steps so nothing is rejected in flight: the validator reads both versions; then the adapters emit `v2`; once the `v1` items have drained, the validator stops reading `v1`, Intake drops its refusal of `context` and `v1/` stays as the record. `v1` items with `context` remain readable, and refused, until the last step.

- **2026-10: added the optional `inReplyTo` field and the pull request source types.** Additive: existing items validate unchanged, and an item may not carry both `inReplyTo` and `context`. The first step of #163 (`docs/design-extension-points.md` §3.2): adapters record what happened and what it continues, and the pipeline decides what it means, so new kinds of turn (#161's questions, #155's merge conflicts) stop being contract changes. Nothing emits `inReplyTo` until Intake reads it; the adapter moves after that, in a later PR. Needs a drain before promotion, as every change to the strict schema does.

- **2026-10: added `comment` to the rework `cause` values.** Additive: existing items validate unchanged. A trusted person who addresses Factorial in a pull request's conversation (`@<slug> rename this to X`) is asking for a change, not reviewing, so the request is answered as theirs and no review is re-requested (#156). Loosening an enum still makes in-flight executions on the previous validator reject the new value, so this needs a drain before promotion.

- **2026-10: added the optional `group` and `parentId` lineage fields.** Additive and backwards-compatible: existing items validate unchanged, and the GitHub issue adapter sets neither. Added while there is one adapter and one consumer, ahead of fan-out across repositories and planner-emitted items. Nothing consumes them yet beyond the ledger. A deliberate contract change: additive, optional, stays in `v1`, and needs a drain before promotion.

- **2026-10: added the optional `context` object (`kind: "rework"`).** Additive and backwards-compatible: existing items validate unchanged. Added so rework requests, which previously had to be flattened into `body`, can carry the pull request, branch and review comments as structured data. Nothing consumes the field yet. This is a deliberate contract change: additive, optional, stays in `v1` per the rules above.
