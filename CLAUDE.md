# Factorial

Factorial is a software factory: an agentic AI system that builds and refines software codebases, built on AWS AgentCore and associated AWS services.

Factorial is built incrementally, largely by itself. This file is split accordingly:

- **Requirements** and **Target architecture** describe where Factorial is heading. They are not yet implemented.
- **Fixed from day one** lists the parts that must be in place from the first version and must not be weakened.
- **Current stage** describes what exists now and what to build next. Work to this section; do not implement target features unless the current task asks for them.

The background design conversation is in `docs/design-conversation.md`. Only what is written in this file is agreed; anything else in that document is a proposal and should not be treated as binding.

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
- If the build fails (a model or API error, or the invoker task stopping), the orchestrator still collects the session: whatever the agent committed, plus any uncommitted changes in a commit marked as saved work in progress, is pushed through the clean room to the work branch. No tests run and no pull request is opened; the failure comment links the branch. The builder's prompt asks it to commit after each coherent step, so a failure loses as little as possible.
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

**Stage 0: complete.** The loop has run end to end: on 2026-10-17 a labelled issue (#2) became a tested pull request (#3) with no human step in between. Done:

- The `WorkItem` contract is defined in `contracts/workitem/v1/` (JSON Schema, with the event envelope and change process in `contracts/workitem/README.md`) and validated by the `@factorial/workitem` package.
- The repository scaffold and CI are in place.
- The foundation stack (`factorial-foundation`) is deployed: GitHub OIDC provider, deploy role, CloudFormation execution role, permissions boundary, artefact bucket and the agent environment ECR repository. The deploy role ARN is the `AWS_DEPLOY_ROLE_ARN` repository secret.
- The deploy workflow runs after CI on `main` and deploys every numbered template above `00`.
- The triggers stack (`factorial-triggers`) is deployed: the `factorial-work` event bus, the webhook secret, and the GitHub issue adapter (`packages/triggers-github-issues`) behind a function URL on its `live` alias. The GitHub App is created and installed, and labelling an issue produces a `WorkItem` on the bus.
- The agent stack (`factorial-agent`) is deployed: the `factorial_builder` harness on the custom image from `agent-environment/`, using GLM 5.3 through the Z.ai API via an AgentCore Identity credential provider, called through the harness's LiteLLM model configuration (model id, reasoning effort `low`, loop timeout, output cap and a sliding context window are template constants; the builder keeps running notes in `/workspace/notes.md` because old messages, including the request, are dropped). The builder has web search: AgentCore's managed Web Search connector behind the `factorial-web-search` gateway, attached as an `agentcore_gateway` tool and allowed as `@web-search/web-search___WebSearch`. LiteLLM is an experiment since 2026-10-17 (#17): the OpenAI chat-completions configuration hit Z.ai 1214 rejections mid-run, and the previous block is kept in the template to revert to, with a `live` endpoint promoted by the deploy workflow. Validated by direct invocation.

- The orchestration stack (`factorial-orchestration`) is deployed: the `factorial-work` state machine (Prepare → Build → Collect → Test → OpenPullRequest) behind its `live` alias, the bus rule that starts it, the `factorial-work-items` ledger, the Fargate invoker (`packages/invoker`) that runs the harness to completion, and the orchestrator Lambdas (`packages/orchestration`) that clone, bundle and push, dispatch `test.yml` and open the PR with GitHub App tokens. The test callback role ARN is the `AWS_TEST_CALLBACK_ROLE_ARN` repository secret.

Next work items are the Stage 0 gaps below and then the ordered list under "Next, in order".

### Stage 0 scope

| Area | Stage 0 |
|---|---|
| Triggers | GitHub issues only |
| EventBridge | One bus, one rule |
| Step Functions | Three states: build → test → PR |
| Agents | One Harness that both plans and builds, using GLM 5.3 via the Z.ai API (general endpoint) |
| Verification | Automated tests run via GitHub Actions; no sandbox smoke test yet |
| Promotion | Move the `live` aliases after a successful deploy |

### Known gaps in Stage 0

- No smoke test, so the output requirement is not yet fully met.
- No staging canary, so Factorial's changes to itself are checked only by tests and human review.
- Only the harness `live` endpoint is promoted as a separate final step. Lambda aliases (SAM `AutoPublishAlias`) and the state machine alias move during the deploy itself. Separating all three comes with the staging canary.
- A change that edits `.github/workflows/` is pushed with a token that also carries `workflows: write`, and CI then runs the edited workflow on the pull request with the repository's secrets available. Those secrets are role ARNs only, and both OIDC trusts are bound to `main`, so the exposure is limited; keep it that way, and review workflow changes with care.
- An installation token with `contents: write` can push to any unprotected branch. `main` is protected by a ruleset (pull request, code-owner review, CI checks, no force push; the App has no bypass; see `docs/github-app.md`), and the orchestrator pushes only to `factorial/*` branches. Other branches are unprotected.
- Rework of a pull request is run by the orchestrator (`context.kind: "rework"` in the `WorkItem` contract): Prepare checks out the previous item's `factorial/*` branch instead of creating one, and writes `/workspace/rework.md` with the review details and, for failed checks, the failing jobs' logs (last 200 lines, redacted, fetched with a short-lived `actions: read` token outside the sandbox). The agent is told to address each point on the existing branch and to say in `summary.md` how each was handled. Collect pushes only on top of the branch head the session started from — the rewrite replays the bundle's commits onto it, so the push is always a fast-forward, never a force push — and the ledger links the rework item to `previousWorkItemId` and the PR number. No trigger produces rework items yet.

### Next, in order

1. Sandbox smoke-test stage (ephemeral AWS account).
2. Staging canary before promotion.

Later stages (more triggers, the full stage graph, separate Planner and Builder agents, Memory, rollback) are added as work items once these are in place.

### Keeping this section up to date

When a change completes or alters a stage, update **Current stage** in the same PR.

## Conventions

- **Deployments:** all deployments run through GitHub Actions. The one exception is the foundation stack (`templates/00-foundation.yml`), which creates the deployment role itself and is deployed by a human as described in `docs/bootstrap.md`. The deploy role trusts only jobs in the `production` GitHub environment, so every workflow job that assumes it must declare `environment: production` and carry the same trust condition as the deploy job; a job without the environment presents a different OIDC subject and is refused. The deploy workflow skips itself when nothing functional changed since the last deploy; see **Non-functional paths** below.
- **IAM:** every role in Factorial's stacks has a name starting `factorial-` and sets `PermissionsBoundary`: agent execution roles are named `factorial-agent` or `factorial-agent-*` and use the `Factorial-AgentPermissionsBoundaryArn` export; every other role uses `Factorial-PermissionsBoundaryArn`. The execution role enforces this pairing and passes only agent roles to AgentCore. AgentCore resources are named `factorial_*`. All Factorial resources use the `factorial-` name prefix (or `factorial/` for ECR, Secrets Manager and SSM); the CloudFormation execution role is scoped to those names.
- **Sandbox access:** agents in the inner loop may deploy to the sandbox environment and read its state directly to verify their work.
- **Infrastructure as code:** Factorial's infrastructure is defined in CloudFormation templates written in YAML, using the `.yml` extension. Templates are numbered and deployed in order; `00-foundation.yml` is deployed by a human, everything from `10-` upwards by the deploy workflow. Templates containing Lambda functions use the `AWS::Serverless-2016-10-31` transform, with `AutoPublishAlias: live` providing versions and the `live` alias; Lambda code is bundled with esbuild from a `packages/` workspace and packaged by `aws cloudformation package`.
- **Triggers:** a GitHub issue becomes a `WorkItem` when the `factorial` label is added to it. The person who adds the label is recorded as the requester.
- **Agent environment:** the harness runs a custom `linux/arm64` image built from `agent-environment/` (Node 22, git, gh, jq). The image and the session hold no credentials. The deploy workflow tags the image with the directory's git tree hash, builds it only when that hash is new, and passes the tag to the agent stack.
- **GitHub identity:** Factorial acts as a GitHub App (`docs/github-app.md`). Only orchestrator Lambdas, outside the agent sandbox, mint installation tokens (`packages/github-app`), scoped to the one target repository and to the permissions the step needs. The agent never pushes or calls GitHub: the orchestrator clones before the agent runs and pushes after it finishes, and the token is never written into the session. Commits are attributed to the App's bot user (`<slug>[bot]`): the clean-room push re-creates the agent's commits with that identity, so whatever author the agent set inside the sandbox is discarded. The App's ID and installation ID live in SSM under `/factorial/github/`.
- **Promotion:** the deploy workflow's final step moves the harness `live` endpoint to the newest version. Templates create endpoints and aliases but never set their target version.
- **Human-provided secrets:** model provider keys and the GitHub App private key are created by a human (`docs/bootstrap.md`, `docs/github-app.md`) and referenced by name. They never pass through templates, parameters or the repository.
- **Language:** all code Factorial owns (Lambdas, tooling, container images) is implemented in TypeScript. The agent loop itself is the managed AgentCore Harness, which is configuration, not code.
- **Model credentials:** third-party model API keys are held in AgentCore Identity's token vault and referenced by ARN. They never appear in the repository, templates, parameters or logs.
- **Compute:** serverless resources are favoured over servers. Where a container is unavoidable, use Fargate, never EC2 instances.
- **Security:** security is vital. The system must enforce suitable access controls at every level: IAM least privilege per role, no shared credentials, and agent roles that can never deploy or promote Factorial.
- **Region:** Factorial and all its associated resources are deployed to `eu-west-1`.
- **Repository layout:** `contracts/` holds versioned, language-neutral contracts (JSON Schema); `packages/` holds TypeScript workspaces; `templates/` holds CloudFormation; `scripts/` holds repository tooling; `.github/workflows/` holds CI and deployment. See `README.md`.
- **Checks:** `npm run ci` runs typecheck, build, tests, the `.yml` extension check and cfn-lint. CI runs the same on every push and PR.
- **Non-functional paths:** `scripts/classify-changes.ts` is the single definition of the paths that cannot affect what Factorial deploys (`docs/**`, `README.md`, `CLAUDE.md`, `LICENSE`, `.editorconfig`, `.github/CODEOWNERS` and similar). Both workflows go through it (via `.github/actions/classify-changes`): CI reports its required checks from a fast path when a pull request changes only those paths, and the deploy workflow skips the deploy when nothing functional changed since the last deployed commit (the `FactorialVersion` parameter on `factorial-orchestration`). Everything not listed there is functional, so new paths are functional by default; a change that should not build or deploy adds itself to the list in that one file.
