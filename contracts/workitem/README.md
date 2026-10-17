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
| `context` | Optional structured context about the work. Optional and additive, so existing items are unaffected. A consumer that ignores it still has `body`. |

### `context`

`context` is a discriminated union on `kind`. Only one kind exists today:

- **`rework`** — the item reworks a previous `WorkItem`'s pull request. It carries the pull request (number and URL), the Factorial working branch (`factorial/…`), the base branch, the previous `WorkItem`'s `id`, the `cause` (`review` or `checks-failed`) and up to 50 `details` (review comments), each with an author, an optional `path` and `line`, and a `body` of at most 8,000 characters.

New kinds add a new `kind` const without changing anything else in the contract. `body` on the `WorkItem` itself stays the human-readable instruction, so a consumer that ignores `context` still gets something sensible.


## What is deliberately left out

- **The Factorial version that handled the work.** That is a property of the execution, not the request. The state machine records it in its output and the PR body.
- **Priority, labels, assignees.** Not needed to close the Stage 0 loop. Add them when a stage needs them.
- **Free-form metadata.** `additionalProperties` is `false` at every level, so unknown fields are rejected at the edge rather than silently carried through.

## Changing the contract

Changing this schema is a deliberate, human-approved decision, never a side effect of other work.

1. Open a PR that changes only the contract and its validator, with the label `contract-change`.
2. **Additive, optional fields** stay in `v1`. Because the schema is strict, in-flight executions on the previous version would reject the new field, so the PR also carries the `requires-drain` label and deployment waits for in-flight executions to finish before promoting.
3. **Breaking changes** (removing or renaming a field, changing a type, tightening a constraint) create `v2/` alongside `v1/` and increment `schemaVersion`. Adapters and consumers move together.
4. Update the examples and the tests in `packages/workitem` in the same PR.

## Change log

- **2026-10: added the optional `context` object (`kind: "rework"`).** Additive and backwards-compatible: existing items validate unchanged. Added so rework requests, which previously had to be flattened into `body`, can carry the pull request, branch and review comments as structured data. Nothing consumes the field yet. This is a deliberate contract change: additive, optional, stays in `v1` per the rules above.
