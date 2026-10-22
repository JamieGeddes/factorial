# The review contract

A review is the reviewer agent's (`factorial_reviewer`) judgement of one `WorkItem`'s change: whether it does what the request and the plan asked, how well it is tested, and whether it is safe. The reviewer writes it as `/workspace/review.json`. The orchestrator reads it out of the reviewer's session, validates it, stores it and shows it in the pull request body.

A review is advisory. It never blocks a pull request; a human still approves every change. The review is internal to Factorial, not part of the `WorkItem` API, but it is the first stored evaluation signal, so it is changed with the same care. The canonical definition is the JSON Schema in `v1/review.schema.json`; the `@factorial/review` package validates against that file.

## Fields

| Field | Purpose |
|---|---|
| `schemaVersion` | Contract version. Always `1` for this schema. |
| `verdict` | `approve` (ready for a human to merge), `request-changes` (something must change first) or `comment` (neither, with points worth reading). |
| `scores` | `correctness`, `completeness`, `tests` and `safety`, each an integer from 1 (poor) to 5 (excellent). |
| `findings[]` | Specific points, most important first, at most 50. Each has a repository-relative `path` (no absolute paths, no `..`), an optional `line` at the branch head, a `severity` (`high`, `medium` or `low`) and a `body`. |
| `summary` | The judgement in a few sentences. Shown in the pull request body. |

Lengths and counts are capped in the schema. `additionalProperties` is `false` at every level.

A `request-changes` verdict does not yet start rework; turning it into a rework item belongs to #22.

## Sensitive-path rules

A target repository can list changes that need particular care in `.factorial/sensitive-paths.json`, following `v1/sensitive-paths.schema.json`. Each rule has a `reason` and exactly one of:

| Match | Meaning |
|---|---|
| `path` | A repository-relative file path, matched exactly. |
| `prefix` | A path prefix, such as a directory ending in `/`. |
| `contentPattern` | A POSIX extended regular expression, matched against each changed file's added and removed lines (`git diff -G`). |

The `reason` completes "This change ...", for example `"changes the IAM roles the service deploys with"`. At most 20 rules.

The orchestrator applies built-in rules first (`.github/workflows/`, `.github/actions/`, `CODEOWNERS` in its three locations, and `.factorial/`), then the repository's, and the first match gives a file's reason. It reads the file from the base branch, never the branch under review. An invalid or oversized file (over 64 KiB) is ignored and recorded in `review/prepared.json` as `rulesProblems`; the built-in rules still apply. Every matched file gets a high-severity finding from the orchestrator in the review, whatever the reviewer concludes.

Factorial's own rules are in its `.factorial/sensitive-paths.json`.

## Changing the contract

1. Change the schema, the examples and the tests in `packages/review` in one PR. For the sensitive-path rules, check Factorial's own `.factorial/sensitive-paths.json` still validates (a test does).
2. **Additive, optional fields** stay in `v1`. Reviews are produced and consumed within one execution, so an in-flight execution never sees a review from another version; no drain is needed.
3. **Breaking changes** create `v2/` alongside `v1/` and increment `schemaVersion`, with the reviewer's prompt and the orchestrator moving together.

## Change log

- **2026-10: v1.** Verdict, four scores, findings and summary. Sensitive-path rules for target repositories.
