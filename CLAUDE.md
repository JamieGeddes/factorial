# Factorial

Factorial is a software factory: an agentic AI system that builds and refines software codebases, built on AWS AgentCore and associated AWS services. It is built incrementally, largely by itself.

This file holds what is agreed and binding, and nothing else:

- **Requirements** and **Target architecture** describe where Factorial is heading. They are not yet implemented.
- **Fixed from day one** lists the parts that must be in place from the first version and must not be weakened.
- **Current stage** describes the shape of what exists now and what to build next. Work to this section; do not implement target features unless the current task asks for them.
- **Conventions** are the rules every change follows.

`docs/architecture-principles.md` is binding on every stage and every design decision; **Fixed from day one** is how the principles are enforced today, and `docs/security.md` sets out the threat model behind them. `docs/current-stage.md` is the detailed record of how the deployed system behaves, stage by stage. `docs/design-conversation.md` and `docs/design-plan.md` are background and proposals: only what is written here and in the principles is agreed.

## Requirements

### Inputs

- Support multiple input triggers:
  - Jira tickets
  - GitHub issues
  - Alerts from production systems
- New trigger types must be addable without changing the core.

### Output

The output of each piece of work is a pull request for human approval, raised only once the change has:

1. Been implemented on a branch.
2. Passed existing and new automated tests.
3. Passed a smoke test in a sandbox deployment environment (a dedicated, ephemeral AWS account).

### Extensibility

The system must be extensible for future requirements, including:

- New trigger types.
- New context providers (e.g. knowledge graphs).
- Integrations with external systems.

### Self-bootstrapping

- Factorial builds itself incrementally, starting from a minimal initial version and basic set of requirements.
- New requirements from the system designer are delivered to Factorial as work, and Factorial updates itself to meet them.
- The end goal is for Factorial to build and maintain other software, e.g. bulk Lambda runtime upgrades across multiple repositories.
- Every PR Factorial raises against its own codebase must be approved by a human.
- Each time a new version of Factorial deploys successfully, that version becomes the one used for the next action.

## Target architecture

### Triggers: EventBridge

- EventBridge is the spine for all incoming work.
- Each trigger source has a thin adapter Lambda that converts its input into a single canonical `WorkItem` event and puts it on the Factorial event bus.
- Adding a trigger type means adding an adapter; nothing downstream changes.

### Orchestration: Step Functions

- A Step Functions state machine runs each `WorkItem` through a fixed stage graph: intake → plan → build → verify → smoke → PR.
- Orchestration stays deterministic; agents run inside the states, not around them.
- Step Functions never deploys anything itself. It dispatches GitHub Actions workflows and waits for a callback (task token) with the result.

### Agents: AgentCore Harness

- Each agent is an AgentCore Harness. The agent loop is managed by AWS and declared as configuration: model, system prompt, tools, limits and container image are defined in CloudFormation and captured in an immutable harness version.
- Model configuration is fixed on the harness version. Nothing passes model overrides at invoke time.
- Deterministic steps around the agent (clone the repository, run tests, push the branch) run through the session command API, not through the model. The command API and the agent invocation must use the same endpoint qualifier, or they address different sessions.
- The agent sandbox holds no credentials beyond the model key. Orchestrator Lambdas, outside the sandbox, mint repository-scoped GitHub App tokens for each step; the agent never pushes or calls GitHub. Once the agent has run, its session is treated as hostile: new commits leave it as a git bundle, and the push happens from a pristine clone in a separate clean-room session with hooks disabled and the token sent as a header.
- The test workflow is dispatched on the default branch, so its definition is always the trusted one. The work commit is checked out as data in a job without credentials; a separate job reports the result. The PR step verifies the branch head is the tested commit.
- A build that stops before finishing, whether by an error or by the builder's own limits, still has its work saved: whatever the agent committed, plus uncommitted changes as a marked work-in-progress commit, is pushed to the work branch, and no untested or unfinished change becomes a pull request.
- A Fargate invoker task runs each harness invocation to completion and Step Functions waits on it (`ecs:runTask.sync`). This keeps long builds off Lambda's time limit and makes completion something the agent cannot forge; lifecycle hooks are not used as control signals because they run under the agent's own role.

### Versioning and promotion: `live` aliases

Factorial has three independently versioned parts. Each has a `live` alias pointing at the version currently in use:

| Part | Versioned resource | `live` pointer |
|---|---|---|
| Agents | AgentCore Harness versions | `HarnessEndpoint` named `live` |
| State machine | Step Functions versions | Alias named `live` |
| Adapters and callbacks | Lambda versions | Alias named `live` |

- Everything references alias ARNs, never version numbers.
- New executions start on whatever `live` points at; in-flight executions finish on the version they started with.
- Moving the `live` aliases is the final step of a successful deployment, so the next `WorkItem` is handled by the newly deployed version.

## Fixed from day one

These are expensive to retrofit or are the safety limits on a self-modifying system. They apply to every stage, including Stage 0.

- **`live` aliases and promotion.** All three parts use `live` aliases from the first version, and every reference uses alias ARNs.
- **The `WorkItem` contract.** Keep it minimal, but treat it as Factorial's API. Changing it is a deliberate, human-approved decision, never a side effect of other work.
- **Human approval.** Every PR against Factorial's own codebase is approved by a human.
- **Agents never deploy or promote Factorial.** Only the GitHub Actions deployment role may deploy Factorial or move a `live` alias. This is enforced by the `factorial-permissions-boundary` (runtime roles) and `factorial-agent-permissions-boundary` (agent roles), one of which every role Factorial creates must carry.

## Current stage

**Stage 0: complete.** On 2026-10-17 a labelled issue (#2) became a tested pull request (#3) with no human step in between. `docs/current-stage.md` has the detail; this is the shape.

- **Pipeline:** a GitHub issue labelled `factorial` → a `WorkItem` on the `factorial-work` bus → the `factorial-work` state machine: Prepare → Plan → CollectPlan → Build → Collect → Test → PrepareReview → Review → CollectReview → OpenPullRequest. Every stage writes its records to the artefact store under `<workItemId>/<attempt>/`, and the `factorial-work-items` ledger row tracks status, usage and pointers.
- **Agents:** three harnesses on one custom image, all GLM 5.3 Flash via the Z.ai API through LiteLLM. The planner (`factorial_planner`) writes `plan.json` (contract `contracts/plan/v1/`) and `plan.md`; the builder (`factorial_builder`) follows `plan.json`, commits as it goes and writes `summary.md`; the reviewer (`factorial_reviewer`) writes `review.json` (contract `contracts/review/v1/`), which is advisory and never blocks a pull request.
- **Stacks:** `factorial-foundation` (deployed by a human: OIDC provider, deploy and execution roles, permissions boundaries, buckets, ECR), `factorial-triggers`, `factorial-agent` and `factorial-orchestration`, the last three deployed from `main` by GitHub Actions, which then promotes the harness `live` endpoints.
- **Rules the stages keep:** only named files are read out of an agent's session, capped, redacted and validated; the push happens from a clean-room clone; the artefact store is write-only apart from the orchestrator reading back the plan files and the builder's notes; an invalid plan gets one retry, then the run ends as `invalid-plan`; a build that stops early saves its work and opens no pull request, and relabelling the issue resumes from the saved branch; the reviewer's sensitive-path rules come from the target repository's base branch (`.factorial/sensitive-paths.json`), never from the branch under review.

### Stage 0 scope

| Area | Stage 0 |
|---|---|
| Triggers | GitHub issues only |
| EventBridge | One bus, one rule |
| Step Functions | plan → build → test → review → PR |
| Agents | Three harnesses, a planner, a builder and a reviewer, all using GLM 5.3 Flash via the Z.ai API (general endpoint) |
| Verification | Automated tests run via GitHub Actions; no sandbox smoke test yet |
| Promotion | Move the `live` aliases after a successful deploy |

### Known gaps in Stage 0

- No smoke test, so the output requirement is not yet fully met.
- No staging canary, so Factorial's changes to itself are checked only by tests and human review.
- Only the harness `live` endpoint is promoted as a separate final step. Lambda aliases (SAM `AutoPublishAlias`) and the state machine alias move during the deploy itself. Separating all three comes with the staging canary.
- A change that edits `.github/workflows/` is pushed with a token that also carries `workflows: write`, and CI then runs the edited workflow on the pull request with the repository's secrets available. Those secrets are role ARNs only, and both OIDC trusts are bound to `main`, so the exposure is limited; keep it that way, and review workflow changes with care.
- An installation token with `contents: write` can push to any unprotected branch. `main` is protected by a ruleset (pull request, code-owner review, CI checks, no force push; the App has no bypass; see `docs/github-app.md`), and the orchestrator pushes only to `factorial/*` branches. Other branches are unprotected.
- Rework of a pull request (`context.kind: "rework"`) is implemented in the orchestrator, but no trigger produces rework items yet.
- The test stage, the builder's prompt and the agent image assume a Node repository with Factorial's own test workflow and callback trust (#91), so only Factorial itself can be a target today.

### Next, in order

1. Staging canary before promotion (#13).
2. Sandbox smoke-test stage (#50, #51), deferred on 2026-10-21. Until it lands, the output requirement's smoke test is not met.

Later stages (more triggers, the full stage graph, Memory, rollback) are added as work items once these are in place.

### Keeping this section up to date

When a change completes or alters a stage, update **Current stage** here (the shape) and `docs/current-stage.md` (the detail) in the same PR. Every agent reads this file at the start of every session: keep it to what is agreed and binding, and put explanation and history in the docs.

## Conventions

- **Deployments:** all deployments run through GitHub Actions. The one exception is the foundation stack (`templates/00-foundation.yml`), which creates the deployment role itself and is deployed by a human as described in `docs/bootstrap.md`. The deploy role trusts only jobs in the `production` GitHub environment, so every workflow job that assumes it must declare `environment: production` and carry the same trust condition as the deploy job; a job without the environment presents a different OIDC subject and is refused. The deploy workflow skips itself when nothing functional changed since the last deploy; see **Non-functional paths** below.
- **IAM:** every role in Factorial's stacks has a name starting `factorial-` and sets `PermissionsBoundary`: agent execution roles are named `factorial-agent` or `factorial-agent-*` and use the `Factorial-AgentPermissionsBoundaryArn` export; every other role uses `Factorial-PermissionsBoundaryArn`. The execution role enforces this pairing and passes only agent roles to AgentCore. AgentCore resources are named `factorial_*`. All Factorial resources use the `factorial-` name prefix (or `factorial/` for ECR, Secrets Manager and SSM); the CloudFormation execution role is scoped to those names.
- **Sandbox access:** agents in the inner loop may deploy to the sandbox environment and read its state directly to verify their work.
- **Infrastructure as code:** Factorial's infrastructure is defined in CloudFormation templates written in YAML, using the `.yml` extension. Templates are numbered and deployed in order; `00-foundation.yml` is deployed by a human, everything from `10-` upwards by the deploy workflow. Templates containing Lambda functions use the `AWS::Serverless-2016-10-31` transform, with `AutoPublishAlias: live` providing versions and the `live` alias; Lambda code is bundled with esbuild from a `packages/` workspace and packaged by `aws cloudformation package`.
- **Triggers:** a GitHub issue becomes a `WorkItem` when the `factorial` label is added to it. The person who adds the label is recorded as the requester.
- **Agent environment:** the harness runs a custom `linux/arm64` image built from `agent-environment/` (Node 22, git, gh, jq, and `quiet` from the `agent-environment/tools` workspace, which keeps command output in `/workspace/logs` and prints a short report). The image and the session hold no credentials. The deploy workflow tags the image with the directory's git tree hash, builds it only when that hash is new, and passes the tag to the agent stack.
- **GitHub identity:** Factorial acts as a GitHub App (`docs/github-app.md`). Only orchestrator Lambdas, outside the agent sandbox, mint installation tokens (`packages/github-app`), scoped to the one target repository and to the permissions the step needs. The agent never pushes or calls GitHub: the orchestrator clones before the agent runs and pushes after it finishes, and the token is never written into the session. Commits are attributed to the App's bot user (`<slug>[bot]`): the clean-room push re-creates the agent's commits with that identity, so whatever author the agent set inside the sandbox is discarded. The App's ID and installation ID live in SSM under `/factorial/github/`.
- **Promotion:** the deploy workflow's final step moves every harness's `live` endpoint to its newest version, finding the harnesses from the agent stack's `*HarnessId` outputs. Templates create endpoints and aliases but never set their target version.
- **Agent roles:** one harness per agent role. In `templates/20-agent.yml` each role is one block: its execution role, harness (with the role's model, prompt, tools and limits) and `live` endpoint, plus outputs `<Role>HarnessArn`, `<Role>HarnessId` and `<Role>LiveEndpointArn`. What roles share (model credential, the `factorial-agent-runtime` policy, the web search gateway) stays outside the blocks. Harnesses are `factorial_<role>` and execution roles `factorial-agent-<role>`; the builder's role keeps the name `factorial-agent`, the one exception. AgentCore creates each harness's runtime log group itself. The invoker serves every role from one task definition, taking `ROLE` and the harness from the state machine. Each role's prompt stays within its role: the builder executes requests, and does not review or propose architecture.
- **Target repositories:** nothing in the code assumes the target repository is Factorial. Per-repository settings (such as the sensitive-path rules) live in the target's `.factorial/`, read from its base branch; Factorial keeps its own there like any other target.
- **Human-provided secrets:** model provider keys and the GitHub App private key are created by a human (`docs/bootstrap.md`, `docs/github-app.md`) and referenced by name. They never pass through templates, parameters or the repository.
- **Language:** all code Factorial owns (Lambdas, tooling, container images) is implemented in TypeScript. The agent loop itself is the managed AgentCore Harness, which is configuration, not code.
- **Model credentials:** third-party model API keys are held in AgentCore Identity's token vault and referenced by ARN. They never appear in the repository, templates, parameters or logs.
- **Compute:** serverless resources are favoured over servers. Where a container is unavoidable, use Fargate, never EC2 instances.
- **Security:** security is vital. The system must enforce suitable access controls at every level: IAM least privilege per role, no shared credentials, and agent roles that can never deploy or promote Factorial.
- **Region:** Factorial and all its associated resources are deployed to `eu-west-1`.
- **Repository layout:** `contracts/` holds versioned, language-neutral contracts (JSON Schema); `packages/` holds TypeScript workspaces; `templates/` holds CloudFormation; `scripts/` holds repository tooling; `.github/workflows/` holds CI and deployment; `.factorial/` holds the settings Factorial reads from any target repository, here for itself. See `README.md`.
- **Workflows:** GitHub Actions definitions follow five rules, enforced by `scripts/check-workflows.ts` (`npm run check:workflows`): (1) every job that assumes the deploy role (`secrets.AWS_DEPLOY_ROLE_ARN` through `aws-actions/configure-aws-credentials`) declares `environment: production` and carries the full deploy trust gate in its `if:` (a `workflow_dispatch` from main, or a successful `workflow_run` of a push to main from this repository); the `classify` and `deploy` jobs of `deploy.yml` are the reference; (2) every remote `uses:` is pinned to a full 40-character commit SHA (local `./...` actions are exempt); (3) no step uses the Actions cache (`actions/cache`, or `cache:` on `actions/setup-node`); (4) a job that uses `./.github/actions/classify-changes` or runs `git diff`, `git log` or `git merge-base` checks out with `fetch-depth: 0`, because a shallow checkout lacks the commit being diffed; (5) `ci.yml` keeps the job names `Typecheck, test and lint` and `Lint CloudFormation`, which the main ruleset requires.
- **Checks:** `npm run ci` runs typecheck, build, tests, the `.yml` extension check, the workflow policy check (`check:workflows`) and cfn-lint. CI runs the same on every push and PR.
- **Artefacts:** every stage writes what it produces to the artefact store under `<workItemId>/<attempt>/<stage>/`, through `putArtefact` in the `@factorial/artefacts` workspace (`packages/artefacts`), shared by the orchestrator and the invoker, which redacts text before upload. Only binary data whose content is pushed anyway (the git bundle) bypasses redaction, through `putBinaryArtefact`. Uploads are idempotent; a retry overwrites the key and versioning keeps the earlier version. The bucket policy denies deletes to every principal: retention is the `ArtefactRetentionDays` lifecycle rule, never a permission. Only orchestrator Lambdas and the invoker may write (`factorial-work-artefacts-write`, `s3:PutObject` only); no agent role can reach the bucket. The orchestrator may read back only named keys it wrote itself, each granted explicitly. The ledger holds the prefix, never content.
- **Correlation:** the work item id is the execution name, the harness session id, the ledger key, the artefact prefix and the `workItemId` attribute on every log line and state output. Every new component must carry it, logging through `@factorial/log`; `docs/finding-a-run.md` must keep reaching every record.
- **Non-functional paths:** `scripts/classify-changes.ts` is the single definition of the paths that cannot affect what Factorial deploys (`docs/**`, `README.md`, `CLAUDE.md`, `LICENSE`, `.editorconfig`, `.github/CODEOWNERS` and similar). Both workflows go through it (via `.github/actions/classify-changes`): CI reports its required checks from a fast path when a pull request changes only those paths, and the deploy workflow skips the deploy when nothing functional changed since the last deployed commit (the `FactorialVersion` parameter on `factorial-orchestration`). Everything not listed there is functional, so new paths are functional by default; a change that should not build or deploy adds itself to the list in that one file.
