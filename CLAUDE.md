# Factorial

Factorial is a software factory: an agentic AI system that builds and refines software codebases, built on AWS AgentCore and associated AWS services. It builds itself incrementally.

This file is what is agreed and binding. **Requirements** and **Target architecture** are where Factorial is heading, not yet implemented. **Fixed from day one** must never be weakened. **Current stage** is what exists and what to build next: work to it, and implement target features only when the task asks. **Conventions** apply to every change.

Also binding: `docs/architecture-principles.md`. `docs/security.md` is the threat model. `docs/current-stage.md` is the detailed record of how the deployed system behaves. `docs/design-conversation.md` and `docs/design-plan.md` are background and proposals, not agreed.

## Requirements

- **Inputs:** Jira tickets, GitHub issues and production alerts, with new trigger types addable without changing the core.
- **Output:** a pull request for human approval, raised only once the change is implemented on a branch, has passed existing and new automated tests, and has passed a smoke test in an ephemeral sandbox AWS account.
- **Extensibility:** new trigger types, new context providers (e.g. knowledge graphs), integrations with external systems.
- **Self-bootstrapping:** Factorial builds itself from a minimal first version; new requirements arrive as work items; the end goal is building and maintaining other software (e.g. bulk Lambda runtime upgrades across repositories). Every PR against its own codebase is approved by a human, and each successful deploy becomes the version used for the next action.

## Target architecture

- **Triggers: EventBridge.** One bus. Each trigger source is a thin adapter Lambda that emits a canonical `WorkItem` event; adding a trigger adds an adapter and nothing downstream changes.
- **Orchestration: Step Functions.** A fixed stage graph (intake → plan → build → verify → smoke → PR), deterministic, with agents inside the states. It never deploys: it dispatches GitHub Actions workflows and waits on a task-token callback.
- **Agents: Claude Agent SDK on AgentCore Runtime.** Each role is a Runtime whose container runs Factorial's host process around the Agent SDK. The role's definition (model, prompt, tools, subagents, hooks, limits, image) is fixed in an immutable Runtime version; nothing overrides it at invoke time, and the request carries only the prompt. The model is Claude on Bedrock, reached with the role's execution role, which names the inference profiles it may call. Deterministic steps (clone, test, push) use the session command API, on the same endpoint qualifier as the invocation. The sandbox holds no credentials; orchestrator Lambdas mint repository-scoped GitHub App tokens and do all GitHub access. A session is hostile once its agent has run: commits leave it as a git bundle and are pushed from a pristine clean-room clone with hooks disabled. The test workflow is dispatched on the default branch, checks the work commit out as data without credentials, and reports from a separate job; the PR step verifies the branch head is the tested commit. A build that stops early still has its committed and uncommitted work saved to the branch, and no unfinished or untested change becomes a PR. A Fargate invoker runs each invocation to completion (`ecs:runTask.sync`); nothing inside a session is a control signal for the orchestrator, since the model's shell shares the session and its role.
- **Versioning: `live` aliases.** Runtime endpoints, the state machine alias and Lambda aliases are all named `live`; everything references alias ARNs, in-flight executions finish on their version, and moving the aliases is the last step of a successful deploy.

## Fixed from day one

- **`live` aliases** on all three parts, every reference by alias ARN.
- **The `WorkItem` contract** is Factorial's API. Changing it is a deliberate, human-approved decision, never a side effect.
- **Human approval** of every PR against Factorial's own codebase.
- **Agents never deploy or promote Factorial.** Only the GitHub Actions deploy role may deploy or move a `live` alias, enforced by `factorial-permissions-boundary` (runtime roles) and `factorial-agent-permissions-boundary` (agent roles); every role Factorial creates carries one.

## Current stage

**Stage 0: complete** (2026-10-17: labelled issue #2 became tested PR #3 with no human step). Detail in `docs/current-stage.md`.

- **Pipeline:** issue labelled `factorial` → `WorkItem` on the `factorial-work` bus → state machine Prepare → Build → Collect → Test → PrepareReview → Review → CollectReview → OpenPullRequest. Every stage writes to the artefact store under `<workItemId>/<attempt>/`; the `factorial-work-items` ledger row tracks status, usage and pointers.
- **Agents:** the builder and the reviewer are AgentCore Runtimes running Factorial's host around the Claude Agent SDK, Claude Sonnet 5.5 on Bedrock (`docs/agent-sdk-plan.md`: the builder since phases 2 and 3.1, 2026-10-25; the reviewer since phase 3.2, 2026-10-26; the Harness code and image removed in phase 4, tag `stage-1-agent-sdk`). Builder `factorial_builder` plans with its read-only `plan` subagent and writes `plan.json` (`contracts/plan/v1/`) and `plan.md`, then follows `plan.json`, commits as it goes, and writes `summary.md`; reviewer `factorial_reviewer` writes `review.json` (`contracts/review/v1/`), advisory only.
- **Stacks:** `factorial-foundation` (human-deployed: OIDC, deploy and execution roles, boundaries, buckets, ECR), then `factorial-triggers`, `factorial-agent`, `factorial-orchestration`, deployed from `main` by GitHub Actions, which then promotes the Runtime `live` endpoints.
- **Pull request body:** seven fixed sections built only by `pr-body.ts`; facts (paths, dependencies, deploy impact, tests, plan, review) come from the orchestrator, and the builder's `summary.md` fills only its own capped slots (`docs/current-stage.md`).
- **Rules the stages keep:** only named files leave an agent session, capped, redacted and validated; the artefact store is write-only except for the orchestrator reading back the plan files and the builder's notes; Collect validates the builder's plan, and a build without a valid one pushes nothing and ends `invalid-plan`; a builder that runs out of steps or time continues in a fresh session from the branch and its notes, up to `MaxBuildRounds`; any other early stop saves the work and opens no PR, and relabelling resumes from the saved branch; the reviewer's sensitive-path rules come from the target's base branch (`.factorial/sensitive-paths.json`), never the branch under review.

### Scope and gaps

Triggers: GitHub issues only. Verification: GitHub Actions tests; no sandbox smoke test, so the output requirement is not met. No staging canary. Only the Runtime `live` endpoints are promoted as a separate step; Lambda and state machine aliases move during the deploy. A change to `.github/workflows/` is pushed with `workflows: write` and CI runs it with the repository's secrets, which are role ARNs only with OIDC trusts bound to `main`: keep it that way and review workflow changes with care. The App token can push to any unprotected branch; `main` is ruleset-protected (`docs/github-app.md`) and the orchestrator pushes only to `factorial/*`. Rework (`context.kind: "rework"`) is implemented but no trigger produces it. The test stage, builder prompt and image assume a Node repository with Factorial's own test workflow and callback trust (#91), so only Factorial can be a target today.

### Next, in order

1. Staging canary before promotion (#13).
2. Sandbox smoke-test stage (#50, #51), deferred 2026-10-21.

Later stages (more triggers, the full stage graph, Memory, rollback) become work items once these are in place.

When a change completes or alters a stage, update **Current stage** here (the shape) and `docs/current-stage.md` (the detail) in the same PR. Every agent reads this file every session: keep it to what is binding.

## Conventions

- **Deployments** run through GitHub Actions, except `templates/00-foundation.yml`, deployed by a human (`docs/bootstrap.md`). Every job that assumes the deploy role declares `environment: production` and the deploy trust gate. The deploy skips when nothing functional changed (**Non-functional paths**).
- **IAM:** every role is named `factorial-*` and carries a boundary: `factorial-agent` or `factorial-agent-*` with `Factorial-AgentPermissionsBoundaryArn`, all others `Factorial-PermissionsBoundaryArn`; only agent roles are passed to AgentCore. AgentCore resources are `factorial_*`; every other resource `factorial-*` (`factorial/` for ECR, Secrets Manager, SSM). The CloudFormation execution role is scoped to those names.
- **Sandbox access:** inner-loop agents may deploy to the sandbox and read its state to verify their work.
- **Infrastructure:** CloudFormation YAML, `.yml` extension, numbered templates deployed in order (`00` by a human, `10-` upwards by the workflow). Lambda templates use the `AWS::Serverless-2016-10-31` transform with `AutoPublishAlias: live`; code is bundled with esbuild from `packages/`, every dependency included (the AWS SDK too: never leave a package for the Lambda runtime to provide, since AWS updates it outside Factorial's deploys), and packaged by `aws cloudformation package`.
- **Triggers:** adding the `factorial` label to a GitHub issue creates a `WorkItem`; the labeller is the requester.
- **Agent environment:** one custom `linux/arm64` image, `agent-runtime/`, holding no credentials, tagged by a hash of its inputs and rebuilt only when that changes. Every role's Runtime runs it: Node 22, git, gh, jq, python3, cfn-lint, `quiet` from `packages/agent-tools` (which keeps command output in `/workspace/logs`), and the host process, which runs the model as the unprivileged `agent` user.
- **GitHub identity:** Factorial is a GitHub App (`docs/github-app.md`). Only orchestrator Lambdas mint installation tokens (`packages/github-app`), scoped to one repository and the step's permissions; the token never enters a session. Commits are re-created under the App's bot user (`<slug>[bot]`) in the clean-room push. App and installation IDs are in SSM under `/factorial/github/`.
- **Promotion:** the deploy workflow's last step moves every Runtime's `live` endpoint to its newest READY version, found from the agent stack's `*RuntimeId` outputs. Templates create endpoints and aliases but never set their target.
- **Agent roles:** one Runtime block per role in `templates/20-agent.yml` (execution role, runtime, `live` endpoint, outputs `<Role>RuntimeArn`, `<Role>RuntimeId`, `<Role>RuntimeLiveEndpointArn`), with `FACTORIAL_ROLE` selecting the role's definition in the host (`packages/agent-runtime`); shared parts (`factorial-agent-runtime` policy, web search gateway) outside the blocks. Runtime `factorial_<role>`, role `factorial-agent-<role>`. The invoker serves every role from one task definition, taking `ROLE` and the Runtime from the state machine. Each prompt stays within its role: the builder executes, it does not review or propose architecture.
- **Target repositories:** nothing in the code assumes the target is Factorial. Per-repository settings live in the target's `.factorial/`, read from its base branch; Factorial keeps its own there like any other target.
- **Secrets:** no agent holds a model key: each Runtime role reaches Bedrock with its execution role, which names the models it may call. The GitHub App private key is created by a human and referenced by name. None appear in the repository, templates, parameters or logs.
- **Language:** TypeScript for all code Factorial owns, including the agent host process. The agent loop is the Agent SDK's; each role's definition (prompt, tools, subagents, hooks, limits, model) is code versioned by the Runtime version.
- **Compute:** serverless first; Fargate where a container is unavoidable, never EC2.
- **Security:** least privilege per role, no shared credentials, agent roles that can never deploy or promote Factorial.
- **Region:** `eu-west-1`.
- **Layout:** `contracts/` (JSON Schema contracts), `packages/` (TypeScript workspaces), `templates/` (CloudFormation), `scripts/` (tooling), `.github/workflows/` (CI and deploy), `.factorial/` (settings Factorial reads from any target, here its own). See `README.md`.
- **Workflows:** five rules, enforced by `scripts/check-workflows.ts`: (1) a job assuming the deploy role declares `environment: production` and the full trust gate in its `if:` (`classify` and `deploy` in `deploy.yml` are the reference); (2) every remote `uses:` is pinned to a 40-character SHA; (3) no Actions cache; (4) a job using `./.github/actions/classify-changes` or `git diff`/`log`/`merge-base` checks out with `fetch-depth: 0`; (5) `ci.yml` keeps the job names `Typecheck, test and lint` and `Lint CloudFormation`, required by the `main` ruleset.
- **Checks:** `npm run ci` (typecheck, build, tests, `.yml` extension check, `check:workflows`, cfn-lint); CI runs the same on every push and PR.
- **Artefacts:** every stage writes to `<workItemId>/<attempt>/<stage>/` through `@factorial/artefacts` (`putArtefact`, which redacts; `putBinaryArtefact` only for the git bundle). Uploads are idempotent and the bucket is versioned; deletes are denied to every principal and retention is the `ArtefactRetentionDays` lifecycle rule. Only orchestrator Lambdas and the invoker write (`s3:PutObject`); the orchestrator reads back only named keys it wrote, each granted explicitly; no agent role reaches the bucket. The ledger holds the prefix, never content.
- **Correlation:** the work item id is the execution name, Runtime session id, ledger key, artefact prefix and `workItemId` on every log line (via `@factorial/log`) and state output. Every component carries it, and `docs/finding-a-run.md` must keep reaching every record.
- **Non-functional paths:** `scripts/classify-changes.ts` is the single list of paths that cannot affect a deploy (`docs/**`, `README.md`, `CLAUDE.md`, `LICENSE`, `.editorconfig`, `.github/CODEOWNERS` and similar). CI takes a fast path for PRs that change only those, and the deploy skips when nothing else changed since `FactorialVersion`. Everything else is functional by default.
