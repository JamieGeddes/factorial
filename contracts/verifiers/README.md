# The verifier contracts

A target repository declares the checks Factorial runs on every change in `.factorial/verifiers.json`, on its base branch (#167). Factorial runs each one in a fresh session it owns, on the verifier Runtime `factorial_verifier`, which can call no model and reaches none of Factorial's data, and records how it went in one result shape. The target's own CI still runs on the pull request as an independent second check.

Both contracts are internal to Factorial, not part of the `WorkItem` API, but a target's file depends on the first, so it changes with the same care. The canonical definitions are the JSON Schemas in `v1/`; the `@factorial/verifiers` package validates against those files.

## `.factorial/verifiers.json` (`v1/verifiers.schema.json`)

| Field | Purpose |
|---|---|
| `schemaVersion` | Always `1`. |
| `verifiers[]` | One to ten verifiers, run in this order on the same commit. Names are unique. |
| `name` | Lower-case letters, digits and hyphens, at most 40 characters: it names the verifier in the pull request and in the artefact store (`verify/<name>/`). |
| `kind` | `command`. The sandbox smoke test (#51) adds a kind. |
| `run` | The shell command, run by bash in the repository's root as an unprivileged user with no credentials, such as `npm ci && npm test`. Exit status 0 is a pass. npm installs come from Factorial's npm mirror. At most 2,000 characters. |
| `required` | `true`: no pull request is opened or updated unless it passes, and the verifiers after it do not run. `false`: its result is shown and the list goes on. |
| `timeoutSeconds` | 30 to 3,300. The check is stopped at its limit and recorded as `timed-out`. |

Without the file, a change is not verified, and its pull request says so. An invalid file ends the turn with no pull request and lists its problems, so a typo cannot remove a gate. The file is read from the base branch, never from the branch under test. One image serves every verifier, with Node 22, git, jq, ripgrep, python3 and cfn-lint; a command the image cannot run is `error`, never a pass (#208 for other toolchains).

Factorial's own file is `.factorial/verifiers.json` at the repository root.

## `verify/<name>/result.json` (`v1/result.schema.json`)

| Field | Purpose |
|---|---|
| `name`, `kind`, `required` | As declared on the base branch. |
| `sha` | The commit the verifier ran on: the branch head Collect pushed. |
| `outcome` | `passed` (exit 0), `failed` (any other status), `timed-out` (stopped at its limit, or by the stage's timeout) or `error` (could not be run or judged: not found, not executable, the session or the task failed). |
| `exitCode`, `detail` | The exit status when there was one; why, in one line, for `error` and `timed-out`. |
| `startedAt`, `finishedAt`, `durationSeconds` | When it ran. |
| `log` | The artefact key of `verify/<name>/output.log` (the last 256 KiB of output, redacted), how many bytes there were in all, and whether the log is cut. |

The invoker writes it after the check; CollectVerifier writes it when the task left none, never as a pass.

## Changing the contracts

1. Change the schema, the examples and the tests in `packages/verifiers` in one PR, and check Factorial's own `.factorial/verifiers.json` still validates (a test does).
2. A breaking change is a new `v2/` beside `v1/`, read alongside it until every enrolled repository has moved.
