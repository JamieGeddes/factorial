# Implementation plan: Claude Agent SDK on AgentCore Runtime

**Date:** 2026-10-23. **Status:** proposed. **Starting point:** tag `stage-0-harness` (the last commit on `main` before this work).

This plan turns the option evaluated in `docs/harness-vs-runtime.md` into a sequence of pull requests. It is deliberately conservative: the Harness stays deployed and remains the default until the Runtime has proved itself on a measured run, every phase is deployable on its own, and the builder is moved first, the reviewer second, and the planner last. The spine (triggers, the state machine, the orchestrator Lambdas, the clean-room push, the trusted test workflow, the artefact store and the ledger) is not changed by this plan except where a stage has to address a Runtime instead of a Harness.

## 1. Target shape

Two AgentCore Runtimes replace three Harnesses:

- **`factorial_builder`**, a Runtime whose container runs a TypeScript host process around the Agent SDK's `query()`. The builder subprocess plans with a read-only `plan` subagent, explores with a read-only `explore` subagent, compacts its own context and commits as it goes. One session per work item, hostile once the model has run.
- **`factorial_reviewer`**, a second Runtime from the same image in review mode, with read-only tools, its own execution role and a fresh session on the tested branch.
- **Claude on Claude Platform on AWS**, reached with SigV4 from each execution role. No model key anywhere in the account.
- The Fargate invoker stays and reads SDK messages instead of Harness events. Prepare, Collect, the clean room, Test, PrepareReview, CollectReview and OpenPullRequest keep their shape.
- The state graph changes in two steps: first every state stays and Build points at the Runtime; then Plan and CollectPlan fold into Build.

The system diagram for the end state is in `docs/harness-vs-runtime.md` under **What it would look like**.

## 2. Facts the plan relies on

Checked on 2026-10-23 against the AWS and Claude documentation and the package registry. Anything here that turns out to be wrong changes the plan, so each phase re-checks what it depends on.

**Agent SDK** (`@anthropic-ai/claude-agent-sdk`)

- Current version 0.3.309. Licence: Anthropic's Commercial Terms of Service (`SEE LICENSE IN README.md`), not an open-source licence. The native Claude Code binary ships as the optional dependency `@anthropic-ai/claude-agent-sdk-linux-arm64`, so no separate install in the image.
- `query(prompt, options)` takes `agents` (programmatic subagents with `tools`, `disallowedTools`, `model`, `maxTurns`, `permissionMode`, `autoCompactWindow`), `hooks` (callbacks in the host process; a `PreToolUse` hook returns `permissionDecision: "deny"`, a `Stop` hook returns `decision: "block"`), `settingSources: []` to read nothing from disk, `permissionMode: "bypassPermissions"` with `allowDangerouslySkipPermissions: true`, `tools` and `disallowedTools`, `maxTurns`, `maxBudgetUsd`, `env` (replaces the subprocess environment), `cwd`, `model`, `systemPrompt`, `includePartialMessages` and `abortController`.
- The result message carries `subtype` (`success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution`), `num_turns`, `duration_ms`, `total_cost_usd` (an estimate), `usage` for the main loop and `modelUsage` for every model call including subagents, and `permission_denials`.
- `bypassPermissions` refuses to run as root. The subprocess runs as a non-root user.
- Subagent caps: `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default 3; `1` turns nesting off), `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20), `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` (default 10 minutes), plus `maxTurns` per agent definition. `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` removes the built-in Explore, Plan and general-purpose agents so only Factorial's definitions exist.
- Hosting: one subprocess per session, about 1 GiB RAM and 1 CPU as a floor, state under `~/.claude/projects/` (or `CLAUDE_CONFIG_DIR`), outbound HTTPS to the provider endpoint. `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turn off memory files, auto-updates, telemetry and feature-flag fetches.

**Claude Platform on AWS**

- Claude Code and the SDK route to it with `CLAUDE_CODE_USE_ANTHROPIC_AWS=1`, `ANTHROPIC_AWS_WORKSPACE_ID` and `AWS_REGION`, signing with the ambient credential chain. The endpoint is `https://aws-external-anthropic.{region}.api.aws`. Model ids are the bare first-party strings; pin them with `ANTHROPIC_DEFAULT_*_MODEL` or pass `model` explicitly.
- IAM service prefix `aws-external-anthropic`; inference is `CreateInference` on the workspace ARN `arn:aws:aws-external-anthropic:{region}:{account}:workspace/{workspace-id}`. **There is no per-model condition key.** The model is therefore fixed by the Runtime version (its environment variables and the host code), not by IAM. This corrects a line in `docs/harness-vs-runtime.md`.
- Web search is available on Claude Platform on AWS (it is not on Bedrock), so the AgentCore web search gateway is not needed once a role moves. Subagents, hooks and compaction work on every provider. The advisor and fast mode do not, and neither is needed.
- The subscription creates a new Anthropic organisation tied to the AWS account; the workspace ID comes from that organisation.

**AgentCore Runtime**

- Container contract: ARM64, listens on `0.0.0.0:8080`, `POST /invocations` with JSON in and JSON or `text/event-stream` out, `GET /ping` returning `{"status": "Healthy" | "HealthyBusy"}`. `HealthyBusy` keeps a session alive past the idle timeout while background work runs.
- Sessions run in a microVM for up to `maxLifetime` (default and maximum 28,800 seconds); `idleRuntimeSessionTimeout` defaults to 900 seconds. The session id is at least 33 characters.
- `InvokeAgentRuntimeCommand` runs a shell command in the same container and session as `InvokeAgentRuntime`, before or after the agent runs, with the same qualifier rule Factorial already follows (same `runtimeSessionId` and the same endpoint qualifier, or it is a different microVM). Commands need `bedrock-agentcore:InvokeAgentRuntimeCommand`, are capped at 3,600 seconds and 25 TPS, and run as root whatever the image says. The existing `session.ts` helper already uses this API against the harness's ARN; it only needs the Runtime's ARN.
- CloudFormation: `AWS::BedrockAgentCore::Runtime` (`AgentRuntimeName` matching `[a-zA-Z][a-zA-Z0-9_]{0,47}`, `AgentRuntimeArtifact.ContainerConfiguration.ContainerUri`, `RoleArn`, `NetworkConfiguration`, `ProtocolConfiguration: HTTP`, `EnvironmentVariables`, `LifecycleConfiguration`) returns `AgentRuntimeArn`, `AgentRuntimeId` and `AgentRuntimeVersion`. `AWS::BedrockAgentCore::RuntimeEndpoint` (`AgentRuntimeId`, `Name`, optional `AgentRuntimeVersion`) returns `AgentRuntimeEndpointArn`, `LiveVersion` and `TargetVersion`. Every update creates an immutable version; `DEFAULT` follows the latest, a named endpoint moves only on `UpdateAgentRuntimeEndpoint`. This is the `live` alias rule exactly.
- The documentation does not state a maximum duration for one streaming `InvokeAgentRuntime` call. The Harness stream has been held for 110 minutes by the invoker, and the Harness runs on the same infrastructure, but this is confirmed in phase 1 before anything depends on it.

**Factorial's own account** (from `templates/00-foundation.yml`)

- The CloudFormation execution role already has `bedrock-agentcore:*` on `runtime/factorial_*`, `CreateAgentRuntime` and `CreateAgentRuntimeEndpoint`. The deploy role already has `UpdateAgentRuntimeEndpoint`, `ListAgentRuntimeVersions` and `GetAgentRuntimeEndpoint` on `runtime/factorial_*`. The deploy role can push to any `repository/factorial/*`. No change is needed there.
- The agent permissions boundary's `Models` statement allows `bedrock:InvokeModel*` only. It must also allow `aws-external-anthropic:CreateInference` on the workspace, which is a foundation change and so a human deploy.
- There are two ECR repositories, `factorial/agent-environment` and `factorial/invoker`. The Runtime image needs a third, also a foundation change.

## 3. Phases

### Phase 0: prerequisites

Human steps and one foundation pull request. Nothing else in the plan can be deployed until these are done.

1. **Subscribe to Claude Platform on AWS** through AWS Marketplace, create a workspace bound to `eu-west-1`, and confirm the regional endpoint answers from that region. Record the workspace ID in SSM as `/factorial/anthropic/workspace-id` (a plain `String`: it is an identifier, not a secret, and it sits beside the GitHub App IDs under `/factorial/`).
2. **Foundation template** (`templates/00-foundation.yml`, deployed by a human per `docs/bootstrap.md`):
   - `AgentPermissionsBoundary`, statement `Models`: add `aws-external-anthropic:CreateInference` and `aws-external-anthropic:CountTokens` on `arn:${AWS::Partition}:aws-external-anthropic:${AWS::Region}:${AWS::AccountId}:workspace/*`. Keep the Bedrock actions until phase 4.
   - A third ECR repository, `factorial/agent-runtime`, with the same settings as the other two and an export `Factorial-AgentRuntimeRepositoryUri`.
   - The CloudFormation execution role's `Parameters` statement, if it does not already cover `/factorial/anthropic/*`, so the agent stack can resolve the workspace ID with a dynamic reference.
3. **Decisions to record in that pull request**, so they are agreed before code lands:
   - The SDK's licence (Commercial Terms of Service) is accepted for this dependency, per the dependency convention.
   - `docs/security.md` gains an accepted-risk entry for in-session enforcement moving to Factorial-owned code, with the mitigations from `docs/harness-vs-runtime.md` (non-root agent user, root-owned host files, `settingSources: []`, model fixed by the version, subagent caps, no subagent output as evidence). Rule 6 is reworded as proposed there.
   - The model for the spike: Claude Sonnet 5.5 as the primary candidate, Claude Haiku 5.5 as the cheap comparison, both against GLM 5.3 Flash on the Harness.

**Done when:** the foundation stack is updated, the workspace ID is in SSM, and a signed SigV4 request to `/v1/messages` from a principal under the agent boundary succeeds.

### Phase 1: the builder Runtime, deployed beside the Harness

The Runtime, its image, the invoker's second path and a stack parameter that chooses which one Build uses. Nothing changes for a work item until the parameter is flipped.

**1.1 The Runtime image** (`agent-runtime/`, built like `agent-environment/`)

- Base: the same pinned `node:22-bookworm-slim` for `linux/arm64`, with the same toolchain as the agent environment (git, gh, jq, `quiet`), so the orchestrator's session commands and the builder's shell see what they see today. The agent-environment Dockerfile is the starting point, not a `FROM` dependency, because the Runtime's entrypoint is Factorial's and the Harness's is AWS's.
- The host process and the SDK are installed under `/opt/factorial/agent-runtime` with `npm ci --omit=dev` from the lockfile, owned by root, mode `0755` directories and `0644` files, so the agent user can execute but not modify them.
- A non-root user `agent` (uid 1000, the base image's `node` user renamed or reused). `USER agent` is the last instruction. `/workspace` is created and owned by `agent`. `CLAUDE_CONFIG_DIR=/workspace/.claude` keeps the SDK's state inside the workspace.
- `ENTRYPOINT` runs the host process on port 8080.
- The image tag is the hash of `agent-runtime/`, `packages/agent-runtime/`, every workspace package it bundles and the lockfile, built only when the tag is absent from ECR, like the invoker image.

**1.2 The host process** (`packages/agent-runtime/`, a TypeScript workspace, bundled with esbuild like the invoker)

- HTTP server: `GET /ping` reports `HealthyBusy` while a run is in progress and `Healthy` otherwise, with `time_of_last_update` set only on change. `POST /invocations` accepts `{ "action": "run", "role": "builder", "prompt": "...", "round": 1 }` and streams SDK messages as SSE, one message per `data:` line; `{ "action": "attach" }` re-attaches to a run in progress and replays what has been streamed so far from the on-disk transcript; `{ "action": "status" }` returns the run's state and, once finished, its result message. One run per session; a second `run` on a busy session is a 409.
- The run: `query(prompt, options)` with `cwd: "/workspace"`, `permissionMode: "bypassPermissions"`, `allowDangerouslySkipPermissions: true`, `settingSources: []`, `tools` listing exactly the built-ins the role may use, `model` from the process environment (set on the Runtime version, never from the request), `systemPrompt` from `prompts/<role>.ts` (ported from the harness blocks in `templates/20-agent.yml`), `maxTurns` and `maxBudgetUsd` from the environment, `agents` from `agents.ts`, `hooks` from `hooks.ts`, and `env` built from a short allow-list of the process environment plus `CLAUDE_CODE_USE_ANTHROPIC_AWS=1`, `ANTHROPIC_AWS_WORKSPACE_ID`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=4`.
- Every SDK message is appended to `/workspace/.factorial/transcript.jsonl` as it arrives and the result message to `/workspace/.factorial/result.json`, so a dropped stream loses nothing and `attach` and `status` have something to serve.
- Hooks in phase 1: `PreToolUse` denies `Edit`, `Write` and `Bash` calls whose path arguments resolve outside `/workspace`, and denies `Bash` invocations of `git push`, `gh auth` and `gh api` with a reason the model can read. These are a constraint on what a prompt injection can drive, not the access gate, as `docs/security.md` says.
- `agents` in phase 1: `explore` only (read-only: `Read`, `Grep`, `Glob`; `model` inherits; `maxTurns` 30). The plan subagent arrives in phase 3.
- Tests: the server contract (ping states, run and attach, 409), the hook decisions, the environment allow-list, and the mapping of result subtypes to outcomes, all without a model.

**1.3 The agent stack** (`templates/20-agent.yml`)

- Parameter `AgentRuntimeImageTag`, passed by the deploy workflow like `AgentImageTag`.
- A new block, in the one-block-per-role layout:
  - `BuilderRuntimeRole`, named `factorial-agent-builder`, trusting `bedrock-agentcore.amazonaws.com` with the source-account condition, carrying `Factorial-AgentPermissionsBoundaryArn`, with `aws-external-anthropic:CreateInference` on the workspace ARN, the existing `factorial-agent-runtime` managed policy for image pull, logs and tracing, and nothing else: no model key, no gateway.
  - `BuilderRuntime`, `AWS::BedrockAgentCore::Runtime`, `AgentRuntimeName: factorial_builder` (the Harness of the same name is a different resource type and ARN; the name survives the cut-over), `ProtocolConfiguration: HTTP`, `NetworkConfiguration.NetworkMode: PUBLIC`, `LifecycleConfiguration` of 900 and 14,400 seconds as the Harness has, and `EnvironmentVariables` for the workspace ID (`{{resolve:ssm:/factorial/anthropic/workspace-id}}`), `FACTORIAL_ROLE=builder`, `FACTORIAL_MODEL`, `FACTORIAL_MAX_TURNS`, `FACTORIAL_MAX_BUDGET_USD`. These are part of the immutable version, which is what "model fixed on the version" means from now on. `AWS_REGION` is reserved and set by the service.
  - `BuilderRuntimeLiveEndpoint`, `AWS::BedrockAgentCore::RuntimeEndpoint`, `Name: live`, no `AgentRuntimeVersion`, so CloudFormation never fights the promotion step.
  - Outputs `BuilderRuntimeArn`, `BuilderRuntimeId`, `BuilderRuntimeLiveEndpointArn`, exported as `Factorial-BuilderRuntimeArn` and `Factorial-BuilderRuntimeId`.
- The existing builder Harness block stays untouched in this phase.

**1.4 The deploy workflow** (`.github/workflows/deploy.yml`)

- A build-and-push step for the Runtime image, mirroring the invoker's, producing `AGENT_RUNTIME_IMAGE_TAG`.
- The promotion step gains a second loop over `*RuntimeId` outputs, using `list-agent-runtime-versions` and `update-agent-runtime-endpoint --endpoint-name live --agent-runtime-version`, with the same already-current and failed-state handling as the Harness loop.
- `scripts/check-workflows.ts` needs no new rule; the new steps follow the existing ones.

**1.5 The invoker** (`packages/invoker/`)

- A `TARGET` environment variable, `harness` (default) or `runtime`, set by the state machine. With `runtime`, the invoker calls `InvokeAgentRuntime` on `RUNTIME_ARN` with qualifier `live`, the session id, the trace baggage header and the `run` payload, and reads the SSE stream line by line. If the stream ends without a result message, it re-invokes with `attach` and continues from the last message it saw, until the result arrives or the stage's timeout fires.
- `transcript.ts` records SDK messages as it records Harness events today (redacted, capped at 50 MB). `usage.ts` gains a mapping from assistant-message usage and the result's `modelUsage` to `RunUsage`, and a `costUsd` field from `total_cost_usd`. `usage.json` records the Runtime version serving `live`, the model and the limits, read with `GetAgentRuntimeEndpoint` and `GetAgentRuntime`.
- Outcome mapping: `success` is complete; `error_max_turns` and `error_max_budget_usd` are incomplete (the rounds path, as `max_iterations_exceeded` is today); `error_during_execution` is a failure. `incompleteReason` gains the SDK subtypes.
- The invoker role (`templates/30-orchestration.yml`) gains `bedrock-agentcore:InvokeAgentRuntime` on `Factorial-BuilderRuntimeArn` and its endpoints, and `GetAgentRuntime` and `GetAgentRuntimeEndpoint` for the record.

**1.6 The orchestrator** (`packages/orchestration/`)

- `session.ts`: the target for a role comes from `BUILDER_RUNTIME_ARN` when `BUILDER_TARGET=runtime`, otherwise from `HARNESS_ARN` as now. One place, no other call site changes.
- `prepare.ts` and `continue-build.ts`: the clone, checkout and seeding commands run as root through the command API, so they end with `chown -R agent:agent /workspace` when the target is the Runtime. `docs/security.md` §8.4 already describes this. `collect.ts` reads files and builds the bundle as root, which needs no change, but its leftover commit runs as `agent` through `runuser` so that root never runs git inside a repository the model controls.
- The Lambdas' environment gains `BUILDER_RUNTIME_ARN` and `BUILDER_TARGET`, and their roles gain `InvokeAgentRuntimeCommand` on the Runtime ARN and its endpoints, mirroring the Harness grants.

**1.7 The state machine** (`templates/30-orchestration.yml`)

- A parameter `BuilderTarget` (`harness` | `runtime`, default `harness`) passed into Build's container overrides as `TARGET` and `RUNTIME_ARN`, and into Prepare and ContinueBuild through the Lambda environment. No state is added or removed.
- `BuildTimeoutSeconds` stays at 7,200; the Runtime's `maxTurns` and `maxLifetime` are set so the SDK ends the run before Step Functions does, as the Harness's `TimeoutSeconds` is today.

**1.8 The spike**

With everything above deployed and `BuilderTarget` still `harness`:

1. Flip `BuilderTarget` to `runtime` with the deploy, relabel a #87-sized issue, and watch the run end to end: Prepare's clone lands in the Runtime session, the invoker streams SDK messages, Collect finds the commits, the clean room pushes, tests run, the reviewer (still on the Harness) reviews, the PR opens.
2. Confirm the open questions in section 5, in particular how long one streaming invocation lasts and whether `attach` is ever needed.
3. Run the same issue on Haiku 5.5 (a Runtime version with a different `FACTORIAL_MODEL`) and on GLM 5.3 Flash on the Harness (`BuilderTarget` back to `harness`).
4. Record rounds, calls, input and output tokens, cache reads, cost, wall time, whether the pull request was accepted and how much human rework it needed, as a **Spike results** section in `docs/harness-vs-runtime.md`, and set `BuilderTarget` back to `harness`.

**Gate for phase 2:** the Runtime completes the item in one session where the Harness needed rounds, at a cost per accepted pull request no worse than twice Flash's, with no finding against the security mitigations. If the gate fails, the Runtime block is removed and the record says why.

### Phase 2: cut the builder over

- `BuilderTarget` defaults to `runtime`. The builder Harness block, its `live` endpoint and the builder's share of the LiteLLM configuration are removed from `templates/20-agent.yml`; the `factorial-agent` role loses its model-key statement. The planner and reviewer keep theirs.
- The builder's web search comes from the SDK's own tool; the gateway stays for the planner until phase 3.
- `maxTurns` and `maxBudgetUsd` are set from the spike's numbers. `SaveWork` and `ContinueBuild` stay as the safety net for an exhausted limit; `MaxBuildRounds` can come down.
- `CLAUDE.md` **Current stage** and the **Agent roles**, **Secrets** and **Language** conventions, `docs/current-stage.md` and `docs/system-diagram.md` are updated in the same pull request, as the stage rule requires. The **Language** convention becomes: TypeScript for all code Factorial owns, including the agent host process; the agent's loop is the SDK's, and its definition (prompt, tools, subagents, limits, model) is versioned by the Runtime version.
- `docs/harness-vs-runtime.md` status line changes to "superseded for the builder; see `docs/agent-sdk-plan.md`".

### Phase 3: the reviewer Runtime and the planner subagent

**3.1 Reviewer** (first, because it is the smaller change and keeps the trust boundary explicit)

- `FACTORIAL_ROLE=reviewer` on a second Runtime, `factorial_reviewer`, from the same image, with role `factorial-agent-reviewer` re-created for the Runtime trust, and a `live` endpoint.
- Tools: `Read`, `Grep`, `Glob` and `Bash`; a `PreToolUse` hook denies every `Edit` and `Write` except `/workspace/review.json`, and denies `Bash` commands that write (`>`, `tee`, `git commit`, `git checkout`, `npm install`). The reviewer's system prompt is ported from its harness block.
- The state machine's Review state passes `TARGET=runtime` and the reviewer's Runtime ARN; PrepareReview and CollectReview address the Runtime through `session.ts`. The reviewer Harness block and the reviewer's model key go.
- The reviewer is advisory, so this phase has no gate beyond a review that validates against `contracts/review/v1/` on a real item.

**3.2 Planner into the builder**

- `agents.plan` in the host process: `Read`, `Grep`, `Glob` only, no `Bash`, `maxTurns` 40, `model` inherits. The builder's system prompt says to run it first and write `/workspace/plan.json` and `/workspace/plan.md` from its report before any edit; the prompt for the plan subagent is ported from the planner's harness block.
- A `PostToolUse` hook on `Write` to `/workspace/plan.json` validates it with `@factorial/plan` and, if invalid, returns the errors so the builder re-plans; after two failures the hook stops the run with `decision: "block"` and a reason, which the invoker reports as `invalid-plan`.
- `collect.ts` reads `plan.json` and `plan.md` out of the builder's session, validates again with the same package, stores them under `plan/` and records `planSize`, so the artefacts and the ledger fields are unchanged. A stored plan that fails validation ends the run as `invalid-plan` whatever happened in the session.
- The state machine loses `Plan`, `CollectPlan` and `PlanAccepted`; `Prepare` goes straight to `Build`. `ContinueBuild` reads the plan from the artefact store as it does now. The `planAttempt` variable goes. The lineage fields stay for the later feature where one trigger fans out into child items; that will need a plan state again and is out of scope here.
- The planner Harness block, its role, the LiteLLM configuration, the `ModelApiKey` credential provider and the web search gateway are removed. `MaxIterations` goes with the last Harness.

**Gate:** two real items through the merged graph, each producing a valid stored plan, a tested branch and a review.

### Phase 4: retire the Harness and tidy the record

- `templates/20-agent.yml` holds two Runtime blocks and the shared policy, and nothing Harness-shaped. The `agent-environment/` image is retired; the Runtime image is the only agent image. The deploy workflow's Harness build and promotion loops go.
- Foundation (human deploy): the agent boundary loses `bedrock:InvokeModel*`, the token-vault and workload-identity statements and the web search statement; the runtime boundary's deny list drops the Harness actions; the Z.ai secret and the `factorial/agent-environment` repository are deleted by hand.
- `CLAUDE.md` **Target architecture** says "Agents: Claude Agent SDK on AgentCore Runtime" with the version rule restated; **Fixed from day one** is unchanged. `docs/security.md` §3.4 is rewritten for subagents and the Runtime, with the accepted-risk entry from phase 0 now in force. `docs/architecture-principles.md` is checked for any principle that named the Harness.
- The invoker's Harness path, `HARNESS_*` variables and the `@aws-sdk/client-bedrock-agentcore-control` harness calls are removed.
- Tag `main` as `stage-1-agent-sdk` and add a one-line pointer from `stage-0-harness` in `docs/current-stage.md`.

## 4. Pull requests, in order

| # | Phase | Contents | Depends on | Done when |
|---|---|---|---|---|
| 1 | 0 | This plan; a correction in `docs/harness-vs-runtime.md` (no IAM model condition); README link | tag `stage-0-harness` | Merged |
| 2 | 0 | Foundation: boundary `CreateInference`, ECR `factorial/agent-runtime`, SSM parameter path; `docs/security.md` accepted-risk entry and rule 6; licence statement; `docs/bootstrap.md` step for the Marketplace subscription and the SSM parameter | Marketplace subscription and workspace exist | Foundation deployed by hand; a signed test request succeeds |
| 3 | 1 | `agent-runtime/` image and `packages/agent-runtime/` host process with tests; SDK pinned at an exact version | 2 | `npm run ci` passes; the image runs locally with a stub provider and answers `/ping` and `/invocations` |
| 4 | 1 | Agent stack Runtime block; deploy workflow build and promotion; `AgentRuntimeImageTag` | 3 | Deploy succeeds; `live` endpoint `READY`; a hand invocation with a trivial prompt returns a result message |
| 5 | 1 | Invoker `TARGET=runtime` path, transcript and usage mapping; invoker IAM | 4 | Unit tests on message mapping; a hand run records `usage.json` with cost |
| 6 | 1 | Orchestrator session targeting, `chown` and `runuser` in Prepare, ContinueBuild and Collect; state machine `BuilderTarget` parameter | 5 | Default `harness`: the existing pipeline is unchanged on a real item |
| 7 | 1 | Spike runs; **Spike results** in the record; gate decision | 6 | Numbers recorded; decision written |
| 8 | 2 | Builder cut-over; Harness builder block removed; docs and `CLAUDE.md` stage update | 7 passed | A real item through the Runtime by default |
| 9 | 3 | Reviewer Runtime; reviewer Harness removed | 8 | A real review validated from the Runtime |
| 10 | 3 | Plan subagent, plan hook, Collect validation; Plan states removed; planner Harness, key, LiteLLM and gateway removed | 9 | Two real items through the merged graph |
| 11 | 4 | Harness code paths and image removed; foundation clean-up (human); docs rewrite; tag `stage-1-agent-sdk` | 10 | `npm run ci`; deploy; record updated |

Pull requests 3 to 6 can be reviewed independently but deploy in order; each is small enough to read in one sitting. Nothing before 8 changes what a work item sees.

## 5. Open questions, settled in phase 1

1. **Streaming duration.** How long one `InvokeAgentRuntime` SSE response may last before the service closes it. The host's `attach` action exists so the answer does not block the spike, but the invoker's reconnect loop is only exercised if it is needed.
2. **Web search.** Whether the SDK's `WebSearch` tool works on Claude Platform on AWS from the Runtime, as the feature table says. If it does not, the gateway stays and the builder gets it as an MCP server through the SDK's `mcpServers`.
3. **User and ownership.** That `chown` after Prepare's root-run clone is enough, and that git inside `/workspace/repo` as `agent` raises no `safe.directory` complaint.
4. **Cold start and image size.** The SDK's native binary and `node_modules` add to the image; measure the session start time against the Harness's and note it beside the token numbers.
5. **Disk.** The SDK's transcript under `CLAUDE_CONFIG_DIR` and Factorial's own under `/workspace/.factorial` both grow with the run; confirm the microVM's ephemeral disk holds a 150-call run with headroom.
6. **Usage accounting.** Whether per-call usage on assistant messages, summed, matches the result's `modelUsage`; the ledger keeps whichever is the sum over every model call including subagents.
7. **Rate limits.** What the workspace's limits are and whether a four-wide subagent fan-out hits them.

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The model is not pinned by IAM | Fixed on the Runtime version through `FACTORIAL_MODEL`, passed as `model` by the host code and never read from the request; `usage.json` records the model the SDK reports, so a mismatch is visible |
| The SDK moves fast and bundles the CLI | Pinned to an exact version in `package.json`; updates are deliberate pull requests that re-run the spike item; the changelog is read before a minor |
| In-session enforcement is Factorial's code | Root-owned host files, non-root agent user, `settingSources: []`, agents and hooks in code, caps in the host; the outer rules stay the gate (`docs/security.md`) |
| Cost per token rises with Sonnet | `maxBudgetUsd` per item; the spike measures cost per accepted pull request, which is the number that decides |
| A run outlives the stream or the session | `HealthyBusy` keeps the session alive; the transcript and result are on disk; `attach` and `status` recover them; `maxLifetime` and `maxTurns` end a run before Step Functions does |
| Subagent fan-out | Depth 1, concurrency 4, per-agent `maxTurns`, the stall watchdog, and one budget for the whole session |
| Ownership mismatches between root commands and the agent user | `chown` after seeding, `runuser` for git in the model's repository, the clean room untouched |
| The Harness is removed before the Runtime is proven | Phases 1 and 2 keep both deployed; `BuilderTarget` flips back in one deploy; `stage-0-harness` is the known-good state |

## 7. Rollback

Until phase 4, every phase is reversible by deploy: `BuilderTarget=harness` returns the builder to the Harness, the reviewer and planner blocks are removed in their own pull requests and can be restored from the tag. After phase 4, the Harness is gone from `main`, and a return means reverting to `stage-0-harness` and re-creating the Z.ai credential. That is the point at which the move is permanent, and it comes only after three real items have gone through the new graph.
