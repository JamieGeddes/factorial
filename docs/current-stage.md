# How Factorial works today

The record of what is deployed and how it behaves, stage by stage. `CLAUDE.md` holds what is agreed and binding (requirements, target architecture, what is fixed from day one, the shape of the current stage and the conventions); this document holds the detail behind its **Current stage** section. When a change completes or alters a stage, both are updated in the same pull request.

Stage 0 is complete: on 2026-10-17 a labelled issue (#2) became a tested pull request (#3) with no human step in between. `docs/finding-a-run.md` goes from a work item id to everything a run produced.

## Triggers

- The triggers stack (`factorial-triggers`) holds the `factorial-work` event bus, the webhook secret and the GitHub issue adapter (`packages/triggers-github-issues`) behind a function URL on its `live` alias.
- Factorial acts as a GitHub App (`docs/github-app.md`), created and installed by a human. Adding the `factorial` label to an issue produces a `WorkItem` on the bus; the person who added the label is the requester.
- The `WorkItem` contract (`v1`) is in `contracts/workitem/v1/` (JSON Schema, with the event envelope and change process in `contracts/workitem/README.md`), validated by `@factorial/workitem`. It carries optional lineage: `group` (`id`, `size`, `index`: the items one trigger produced) and `parentId` (the item whose Plan stage emitted it). Prepare copies them onto the ledger row as `groupId`, `groupSize`, `groupIndex` and `parentId`, and `groupId-createdAt-index` and `parentId-createdAt-index` list a group's or a parent's items. Nothing produces or reads them yet.

## The state machine

The orchestration stack (`factorial-orchestration`) holds the `factorial-work` state machine (Prepare → Plan → CollectPlan → Build → Collect → Test → PrepareReview → Review → CollectReview → OpenPullRequest) behind its `live` alias, the bus rule that starts it, the `factorial-work-items` ledger, the Fargate invoker (`packages/invoker`), the orchestrator Lambdas (`packages/orchestration`) and the artefact store. Every state's output carries `workItemId` and `attempt`.

### Prepare

- Creates the ledger row and the artefact prefix, clones the repository into the planner's session on a new `factorial/<workItemId>` branch, and seeds `/workspace/notes.md` with the request under `# Task` (the harness drops nothing from the conversation at this model, but the notes file is what a later session starts from).
- **Resume:** a new item from the same source as an earlier attempt that failed after saving work, or whose tests failed, resumes on that attempt's `factorial/*` branch. Prepare finds it through the ledger's `sourceKey-createdAt-index` and adds a "Previous attempt" section to the notes. A resumed item's attempt is one more than the attempt it resumes, and its artefact prefix uses its own id. Attempts made before the index existed are not found.
- **Rework** (`context.kind: "rework"` in the `WorkItem` contract): Prepare checks out the previous item's `factorial/*` branch instead of creating one, and writes `/workspace/rework.md` with the review details and, for failed checks, the failing jobs' logs (last 200 lines, redacted, fetched with a short-lived `actions: read` token outside the sandbox). The agent is told to address each point on the existing branch and to say in `summary.md` how each was handled. The ledger links the rework item to `previousWorkItemId` and the PR number. No trigger produces rework items yet.

### Plan and CollectPlan

- The planner (`factorial_planner`, role `factorial-agent-planner`) runs in its own session with the clone. It writes `/workspace/plan.json`, the plan the builder follows (steps in order by `id`, each with files and a verification; tests to run and add; risks; open questions; optional `followUp` for work that belongs in a separate item), following the plan contract in `contracts/plan/v1/` and validated by `@factorial/plan`; and `/workspace/plan.md`, its explanation for humans.
- CollectPlan reads only those two files out of the planner's session (at most 64 KiB each, redacted), validates the JSON, stores both with `plan/validation.json`, and records the plan's size (`planSize`: steps, distinct files, description characters, follow-up items) on the ledger row beside the builder's usage. There is no limit on a plan's size beyond the contract's 30 steps.
- A valid plan is seeded into a fresh builder session cloned at the same commit (the builder's session is set up only then, because sessions close after 15 minutes idle). The first invalid plan runs the planner once more with the problems appended to its notes; a second ends the run with `invalid-plan`, reported on the issue. The ledger holds the planner's run under `plan` and `planAttempts`.

### Build

- The builder (`factorial_builder`, role `factorial-agent`) follows `plan.json` step by step, commits after each coherent step, keeps running notes in `/workspace/notes.md`, and writes `/workspace/summary.md` with a `## Plan steps` section reporting each step by its `id`. Its prompt sets an exploration budget before the first edit, forbids installs for documentation-only changes, states once that GitHub belongs to the orchestrator, and keeps the builder to executing the request.
- The Fargate invoker runs the harness invocation to completion and Step Functions waits on it (`ecs:runTask.sync`). It takes the role and the harness from the state machine's container overrides, passes no `maxIterations` or `timeoutSeconds` (each harness version's own limits apply), records `role` on the ledger row, and passes the ids to the harness in the `baggage` header.
- A builder that stops with any reason but `end_turn` (its iteration or time limit) is incomplete: the invoker records `buildError` and exits with code 3, so a half-finished change is never tested or opened as a pull request.

### Collect and SaveWork

- Collect inspects the builder's session (hostile once the agent has run), commits anything left uncommitted, stores the session's files, and bundles the new commits. The push happens from a pristine clone in a separate clean-room session with hooks disabled and the token sent as a header; every commit is re-created with the App's identity, and the push is always a fast-forward on top of the head the session started from, never a force push.
- When the build fails (a model or API error, the invoker task stopping, or the builder running out), SaveWork runs Collect in salvage mode: whatever the agent committed, plus any uncommitted changes in a commit marked as saved work in progress, is pushed to the work branch. No tests run and no pull request is opened; the failure comment links the branch, and relabelling the issue resumes from it.

### Test

- The test workflow (`test.yml`) is dispatched on the default branch, so its definition is always the trusted one. The work commit is checked out as data in a job without credentials; a separate job reports the result through a Step Functions task token, assuming the test callback role (its ARN is the `AWS_TEST_CALLBACK_ROLE_ARN` repository secret). A failed run ends the item as `tests-failed`, reported on the issue with the branch left for inspection.

### PrepareReview, Review and CollectReview

- PrepareReview clones the pushed branch into a fresh reviewer session, checks that its head is the tested commit, and writes the validated `plan.json` and `plan.md` (read back from the artefact store), the builder's `summary.md` and `diff.patch` (three-dot against the base branch).
- Before the reviewer runs it works out which changed files are sensitive: built-in rules that hold for any repository on GitHub (Actions workflows and composite actions, `CODEOWNERS`, any `.gitattributes`, `.factorial/`) plus the target repository's own rules in `.factorial/sensitive-paths.json` (exact paths, prefixes, file names and diff content patterns, each with a reason; contract in `contracts/review/v1/sensitive-paths.schema.json`). The rules file is read from the base branch, never the branch under review, so a change cannot loosen the rules that judge it; an invalid file is logged and stored as `rulesProblems`, and the built-in rules still apply. Rename detection is off and diffs are forced to text without textconv, so a moved file is caught under its old path and a branch's `.gitattributes` cannot hide lines. Factorial's own rules (the foundation template, permissions boundaries, the workflow and change-classification checks) live in its `.factorial/sensitive-paths.json`, not in the code.
- The reviewer (`factorial_reviewer`, role `factorial-agent-reviewer`) judges the change against the request and the plan, treating everything it reads as untrusted, with the flagged files and their reasons in its prompt, and writes `/workspace/review.json` (verdict, four scores from 1 to 5, findings, summary; contract in `contracts/review/v1/`, validated by `@factorial/review`). Its prompt budgets 25 reads and has it write the review early and refine it.
- CollectReview reads only `review.json` out of the session (at most 64 KiB, redacted), validates it and adds a high-severity finding for every sensitive change, whatever the reviewer wrote about it. The review is advisory: the PR body shows the verdict, scores and findings, and if any review step fails the PR still opens, saying the review did not complete. The ledger holds the reviewer's run under `review` and the result as `reviewVerdict`, `reviewScores` and `reviewFindings`.

### OpenPullRequest and Report

- OpenPullRequest verifies the branch head is the tested commit and opens the pull request with the builder's summary, the plan with the builder's per-step report, the review and a run-details table linking the artefact prefix. Every terminal path writes `report.json`, and Report comments on the issue when no pull request follows (no changes, tests failed, invalid plan, or a failure, with the saved branch linked).

## Agents

- All three harnesses run the custom `linux/arm64` image from `agent-environment/` (Node 22, git, gh, jq, and `quiet`, which keeps command output in `/workspace/logs` and prints a short report). The image and the session hold no credentials. The deploy workflow tags the image with the directory's git tree hash, builds it only when that hash is new, and passes the tag to the agent stack.
- The model is GLM 5.3 Flash through the Z.ai API, via an AgentCore Identity credential provider and the harness's LiteLLM model configuration. Model id, reasoning effort, loop timeout, iteration cap and output cap are template constants per role. LiteLLM has been in use since 2026-10-17 (#17): the OpenAI chat-completions configuration hit Z.ai 1214 rejections mid-run, and the previous block is kept in the template to revert to.

| Role | Effort | Iterations | Loop | Web search |
|---|---|---|---|---|
| Planner | high | 60 | 30 min | yes |
| Builder | low | 150 | 110 min | yes |
| Reviewer | high | 40 | 15 min | no |

- Web search is AgentCore's managed Web Search connector behind the `factorial-web-search` gateway, attached as an `agentcore_gateway` tool and allowed as `@web-search/web-search___WebSearch`.
- Each harness is configured with summarisation truncation, but the harness applies truncation only when the conversation exceeds the model's context window, which GLM 5.3 Flash's 1M-token window has never reached. In practice a session's context only grows; the builder's notes file and the branch are what carry state between sessions.
- The template is laid out one block per role (see **Agent roles** in `CLAUDE.md` Conventions). The deploy workflow's final step moves every harness's `live` endpoint to its newest version.

## The artefact store and the ledger

The artefact store (`factorial-work-artefacts-<account>`, in the orchestration stack) keeps each run's record under `<workItemId>/<attempt>/`. The ledger row holds `attempt` and `artefactPrefix`, and the pull request body links the prefix. The store is write-only, with two read exceptions by the orchestrator: the plan files (PrepareReview) and, when a build continues, the builder's notes.

| Key | Written by | Contents |
|---|---|---|
| `workitem.json`, `prepare/branch.json` | Prepare | The work item and the branch |
| `plan/plan.md`, `plan/plan.json`, `plan/validation.json` | CollectPlan | The plan and its validation |
| `plan/transcript.jsonl`, `plan/usage.json` | Invoker | The planner's run |
| `build/transcript.jsonl`, `build/usage.json` | Invoker | Every harness stream event (redacted, capped at 50 MB with a truncation marker) and the usage: summed and per-call tokens, harness version, model id, stop reason, tool calls, duration; written on every exit including a stopped task (`stopReason: "interrupted"`) |
| `build/summary.md`, `build/notes.md`, `build/rework.md`, `build/logs/<name>`, `build/logs/index.json`, `build/bundle.git` | Collect, before the push (SaveWork too) | The session's files; command logs 5 MB per file keeping the end and 50 MB in total, with the index listing what was stored, truncated or skipped |
| `test/result.json` | OpenPullRequest, or Report when tests fail | The test outcome and run |
| `review/prepared.json` | PrepareReview | The tested head, changed paths, the rules applied and the sensitive paths |
| `review/transcript.jsonl`, `review/usage.json` | Invoker | The reviewer's run |
| `review/review.json`, or `review/error.json` and `review/review.raw.json` | CollectReview | The review with the orchestrator's findings added, or why there is none |
| `pr/pr.json` | OpenPullRequest | The pull request |
| `report.json` | Every terminal path | The outcome and a short reason |

The ledger row points at the build records with `build.transcriptKey` and `build.usageKey` and keeps the existing `usage` totals until the progress record (#15) defines per-stage fields. Token usage is recorded the way Z.ai reports it: `inputTokens` is the gross prompt size including cache reads, and `uncachedInputTokens` is what is billed at full rate.

## Logging and correlation

Every orchestrator Lambda and the invoker log one JSON object per line through `@factorial/log` (`workItemId`, `attempt`, `stage`, `level`, `message`, redacted). The work item id is the execution name, the harness session id, the ledger key, the artefact prefix and the `workItemId` attribute on every log line and state output. AgentCore traces are not yet exported (CloudWatch Transaction Search is off), so finding a run's trace by its id is still unproven.

## Stacks and deployment

- `factorial-foundation` (deployed by a human, `docs/bootstrap.md`): GitHub OIDC provider, deploy role, CloudFormation execution role, the two permissions boundaries, the artefact bucket and the agent environment ECR repository. The deploy role ARN is the `AWS_DEPLOY_ROLE_ARN` repository secret.
- The deploy workflow runs after CI on `main`, deploys every numbered template above `00`, and then promotes the harness `live` endpoints. It skips itself when nothing functional changed since the last deploy (`scripts/classify-changes.ts`).
