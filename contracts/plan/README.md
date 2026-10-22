# The plan contract

A plan is what the planner agent (`factorial_planner`) decided to change for one `WorkItem`, and how to verify it. The planner writes it as `/workspace/plan.json`, alongside `/workspace/plan.md` for humans. The orchestrator reads it out of the planner's session, validates it and stores it; the builder follows it.

The plan is internal to Factorial, not part of the `WorkItem` API, but the orchestrator acts on it, so it is changed with the same care. The canonical definition is the JSON Schema in `v1/plan.schema.json`; the `@factorial/plan` package validates against that file.

## Fields

| Field | Purpose |
|---|---|
| `schemaVersion` | Contract version. Always `1` for this schema. |
| `summary` | The change in a few sentences: what and why. Shown in the pull request body. |
| `steps[]` | The change, in order, 1 to 30 steps. Each has an `id` (lowercase, digits and hyphens, unique in the plan), a `description`, the repository-relative `files` it touches (no absolute paths, no `..`) and a `verification`. |
| `tests.run` | Commands to run once the change is made. |
| `tests.add` | Tests to add or change, one sentence each. |
| `risks` | What could go wrong. May be empty. |
| `openQuestions` | What the request leaves undecided, and the assumption the plan makes for each. May be empty. |
| `followUp` | Optional. Work the request mentions that belongs in a separate work item (another repository, a decision the requester must make first, a change mentioned but not asked for), one sentence each. Not a way to shorten a plan. Shown in the pull request body; a human raises the items until fan-out (#55) does. |

Lengths and counts are capped in the schema. The validator also checks that step ids are unique, which JSON Schema cannot express. `additionalProperties` is `false` at every level.

## Planned extension

Fan-out (#55) adds an optional `children[]`: child work items the plan splits the request into, in which case the plan has no steps of its own. Until then a plan that carries `children` is rejected.

## Changing the contract

1. Change the schema, the examples and the tests in `packages/plan` in one PR.
2. **Additive, optional fields** stay in `v1`. Plans are produced and consumed within one execution, so an in-flight execution never sees a plan from another version; no drain is needed.
3. **Breaking changes** create `v2/` alongside `v1/` and increment `schemaVersion`, with the planner's prompt and the orchestrator moving together.

## Change log

- **2026-10: v1.** Summary, steps, tests, risks and open questions. Optional `followUp` added for work that belongs in a separate item.
