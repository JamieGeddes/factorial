# The `WorkItem` contract

`WorkItem` is Factorial's API. Every trigger adapter converts its input into exactly one `WorkItem` and places it on the Factorial event bus. Everything downstream (Step Functions, the agent, the PR stage) consumes only this shape and knows nothing about where the work came from.

The canonical definition is the JSON Schema in `v1/workitem.schema.json`. The TypeScript package `@factorial/workitem` validates against that file; it does not define the contract.

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
| `schemaVersion` | Contract version. Always `1` for this schema. |
| `id` | UUID assigned by the adapter. Used as the Step Functions execution name and for tracing. |
| `source.type` | Trigger type, kebab-case, e.g. `github-issue`. New triggers add a value; nothing else changes. |
| `source.id` | Identifier within the source system, e.g. the issue number. |
| `source.url` | Link back to the originating record. |
| `repository` | Provider, owner and name of the target repository. |
| `title`, `body` | The work, as the requester wrote it. |
| `requestedBy` | Requester identity in the source system. |
| `createdAt` | When the adapter created the `WorkItem`. |
| `group` | Optional. The set of items one trigger produced: `id` (UUID, shared by the set), `size` (at least 1) and `index` (1 to `size`). `size` lets a consumer tell when the set is complete. The validator also checks `index` ≤ `size`, which JSON Schema cannot express. |
| `parentId` | Optional. The `id` of the `WorkItem` whose Plan stage emitted this one. |
| `context` | Optional structured context about the work. Optional and additive, so existing items are unaffected. A consumer that ignores it still has `body`. |

### `context`

`context` is a discriminated union on `kind`. Only one kind exists today:

- **`rework`** — the item reworks a previous `WorkItem`'s pull request. It carries the pull request (number and URL), the Factorial working branch (`factorial/…`), the base branch, the previous `WorkItem`'s `id`, the `cause` (`review`, `checks-failed`, or `comment` for a request made in the pull request's conversation) and up to 50 `details` (review comments), each with an author, an optional `path` and `line`, and a `body` of at most 8,000 characters.

New kinds add a new `kind` const without changing anything else in the contract. `body` on the `WorkItem` itself stays the human-readable instruction, so a consumer that ignores `context` still gets something sensible.


## One repository per WorkItem

A `WorkItem` is one unit of work for the pipeline: one repository, one branch, one pull request.

A trigger that applies to several repositories produces one `WorkItem` per repository. Fan-out happens before the pipeline: in the adapter when the repository list comes from configuration, or in a future intake step when the list has to be worked out.

`repository` stays a single object. Turning it into a list is a breaking change and is not planned.

The items from one trigger are linked by `group`, so results can be reported back to the source as a set.

## Lineage

`group` and `parentId` record where an item came from; neither changes how it is handled.

- **`group`**: the items one trigger produced, for example one per repository. Siblings share `group.id`; `size` and `index` say how many there are and which this is.
- **`parentId`**: the item whose Plan stage split its work into this one.
- **Rework** is a different relationship (same branch, same pull request) and stays in `context.previousWorkItemId`.

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

- **2026-10: added `comment` to the rework `cause` values.** Additive: existing items validate unchanged. A trusted person who addresses Factorial in a pull request's conversation (`@<slug> rename this to X`) is asking for a change, not reviewing, so the request is answered as theirs and no review is re-requested (#156). Loosening an enum still makes in-flight executions on the previous validator reject the new value, so this needs a drain before promotion.

- **2026-10: added the optional `group` and `parentId` lineage fields.** Additive and backwards-compatible: existing items validate unchanged, and the GitHub issue adapter sets neither. Added while there is one adapter and one consumer, ahead of fan-out across repositories and planner-emitted items. Nothing consumes them yet beyond the ledger. A deliberate contract change: additive, optional, stays in `v1`, and needs a drain before promotion.

- **2026-10: added the optional `context` object (`kind: "rework"`).** Additive and backwards-compatible: existing items validate unchanged. Added so rework requests, which previously had to be flattened into `body`, can carry the pull request, branch and review comments as structured data. Nothing consumes the field yet. This is a deliberate contract change: additive, optional, stays in `v1` per the rules above.
