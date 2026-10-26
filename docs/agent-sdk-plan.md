# Implementation plan: Claude Agent SDK on AgentCore Runtime

**Date:** 2026-10-23. **Status:** proposed. **Starting point:** tag `stage-0-harness` (the last commit on `main` before this work).

This plan turns the option evaluated in `docs/harness-vs-runtime.md` into a sequence of pull requests. It is deliberately conservative: the Harness stays deployed and remains the default until the Runtime has proved itself on a measured run, every phase is deployable on its own, and the builder is moved first, the planner second, and the reviewer last. The spine (triggers, the state machine, the orchestrator Lambdas, the clean-room push, the trusted test workflow, the artefact store and the ledger) is not changed by this plan except where a stage has to address a Runtime instead of a Harness.

## 1. Target shape

Two AgentCore Runtimes replace three Harnesses:

- **`factorial_builder`**, a Runtime whose container runs a TypeScript host process around the Agent SDK's `query()`. The builder subprocess plans with a read-only `plan` subagent, explores with a read-only `explore` subagent, compacts its own context and commits as it goes. One session per work item, hostile once the model has run.
- **`factorial_reviewer`**, a second Runtime from the same image in review mode, with read-only tools, its own execution role and a fresh session on the tested branch.
- **Claude on Amazon Bedrock** in `eu-west-1`, through the EU cross-region inference profiles, reached with SigV4 from each execution role and scoped by IAM to one inference profile per role. No model key anywhere in the account.
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

**Amazon Bedrock** (the route chosen on 2026-10-23; Claude Platform on AWS was the earlier default and remains a one-variable alternative)

- Claude Code and the SDK route to Bedrock with `CLAUDE_CODE_USE_BEDROCK=1` and `AWS_REGION`, signing with the ambient credential chain, which in a Runtime is the execution role. The model is pinned with `ANTHROPIC_MODEL` set to a cross-region inference profile id; `ANTHROPIC_DEFAULT_HAIKU_MODEL` names the small model for background calls. Claude Code uses the Invoke API, not Converse.
- Verified in the account on 2026-10-23: `eu.anthropic.claude-sonnet-5-5` and `eu.anthropic.claude-haiku-5-5` are `ACTIVE` inference profiles in `eu-west-1`, and the 5.x models are offered as inference profiles only. The Anthropic use-case form was submitted on 2026-10-23, and an `InvokeModel` on `eu.anthropic.claude-haiku-5-5` in `eu-west-1` succeeded the same day.
- IAM: `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the inference profile ARN (`arn:aws:bedrock:eu-west-1:{account}:inference-profile/eu.anthropic.claude-sonnet-5-5`) and on the foundation-model ARNs the profile routes to (`arn:aws:bedrock:{eu-region}::foundation-model/anthropic.claude-sonnet-5-5` for each EU region in the profile). **This pins the model by IAM**, which Claude Platform on AWS cannot do. `bedrock:ListInferenceProfiles` and `bedrock:GetInferenceProfile` are optional: the SDK uses them for discovery and falls back without them.
- Prompt caching works on Bedrock for these models; the spike confirms cache reads are non-zero in `eu-west-1`. `ENABLE_PROMPT_CACHING_1H=1` buys the one-hour TTL at a higher write rate. Sonnet 5.5 and Haiku 5.5 get the 1M-token window by default; `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` keeps 200K, which makes compaction fire earlier and is the setting to compare in the spike.
- Claude Code's own `WebSearch` tool is **not available on Bedrock**. The AgentCore web search gateway therefore stays, offered to the SDK as an in-process MCP tool from the host (`createSdkMcpServer` with a `web_search` tool that calls the gateway with SigV4, as the agent boundary already permits). Subagents, hooks and compaction work on every provider.
- Prices are Anthropic's list prices on the AWS bill, with no Marketplace subscription beyond the use-case form; cross-region EU profiles bill at the source region's rate.

**AgentCore Runtime**

- Container contract: ARM64, listens on `0.0.0.0:8080`, `POST /invocations` with JSON in and JSON or `text/event-stream` out, `GET /ping` returning `{"status": "Healthy" | "HealthyBusy"}`. `HealthyBusy` keeps a session alive past the idle timeout while background work runs.
- Sessions run in a microVM for up to `maxLifetime` (default and maximum 28,800 seconds); `idleRuntimeSessionTimeout` defaults to 900 seconds. The session id is at least 33 characters.
- `InvokeAgentRuntimeCommand` runs a shell command in the same container and session as `InvokeAgentRuntime`, before or after the agent runs, with the same qualifier rule Factorial already follows (same `runtimeSessionId` and the same endpoint qualifier, or it is a different microVM). Commands need `bedrock-agentcore:InvokeAgentRuntimeCommand`, are capped at 3,600 seconds and 25 TPS, and run as root whatever the image says. The existing `session.ts` helper already uses this API against the harness's ARN; it only needs the Runtime's ARN.
- CloudFormation: `AWS::BedrockAgentCore::Runtime` (`AgentRuntimeName` matching `[a-zA-Z][a-zA-Z0-9_]{0,47}`, `AgentRuntimeArtifact.ContainerConfiguration.ContainerUri`, `RoleArn`, `NetworkConfiguration`, `ProtocolConfiguration: HTTP`, `EnvironmentVariables`, `LifecycleConfiguration`) returns `AgentRuntimeArn`, `AgentRuntimeId` and `AgentRuntimeVersion`. `AWS::BedrockAgentCore::RuntimeEndpoint` (`AgentRuntimeId`, `Name`, optional `AgentRuntimeVersion`) returns `AgentRuntimeEndpointArn`, `LiveVersion` and `TargetVersion`. Every update creates an immutable version; `DEFAULT` follows the latest, a named endpoint moves only on `UpdateAgentRuntimeEndpoint`. This is the `live` alias rule exactly.
- The documentation does not state a maximum duration for one streaming `InvokeAgentRuntime` call. The Harness stream has been held for 110 minutes by the invoker, and the Harness runs on the same infrastructure, but this is confirmed in phase 1 before anything depends on it.

**Factorial's own account** (from `templates/00-foundation.yml`)

- The CloudFormation execution role already has `bedrock-agentcore:*` on `runtime/factorial_*`, `CreateAgentRuntime` and `CreateAgentRuntimeEndpoint`. The deploy role already has `UpdateAgentRuntimeEndpoint`, `ListAgentRuntimeVersions` and `GetAgentRuntimeEndpoint` on `runtime/factorial_*`. The deploy role can push to any `repository/factorial/*`. No change is needed there.
- The agent permissions boundary's `Models` statement already allows `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on `*`, and its `WebSearch` statement allows the gateway. The execution role narrows both; no boundary change is needed.
- There are two ECR repositories, `factorial/agent-environment` and `factorial/invoker`. The Runtime image needs a third, which is a foundation change and so a human deploy.

## 3. Phases

### Phase 0: prerequisites

Human steps and one foundation pull request. Nothing else in the plan can be deployed until these are done.

1. **Enable Anthropic models in Bedrock.** In the Bedrock console for `eu-west-1`, open the model catalog, select an Anthropic model and submit the use-case form (once per account; access is immediate). Confirm with `aws bedrock get-use-case-for-model-access --region eu-west-1` and a test `InvokeModel` on `eu.anthropic.claude-haiku-5-5`. Record the step in `docs/bootstrap.md`.
2. **Foundation template** (`templates/00-foundation.yml`, deployed by a human per `docs/bootstrap.md`): a third ECR repository, `factorial/agent-runtime`, with the same settings as the other two and an export `Factorial-AgentRuntimeRepositoryUri`. Nothing else: the agent boundary already allows Bedrock inference and the gateway, and the CloudFormation and deploy roles already cover `runtime/factorial_*`.
3. **Decisions to record in that pull request**, so they are agreed before code lands:
   - The SDK's licence (Commercial Terms of Service) is accepted for this dependency, per the dependency convention.
   - `docs/security.md` gains an accepted-risk entry for in-session enforcement moving to Factorial-owned code, with the mitigations from `docs/harness-vs-runtime.md` (non-root agent user, root-owned host files, `settingSources: []`, model fixed by the version, subagent caps, no subagent output as evidence). Rule 6 is reworded as proposed there.
   - The model for the spike: Claude Sonnet 5.5 as the primary candidate, Claude Haiku 5.5 as the cheap comparison, both against GLM 5.3 Flash on the Harness.

**Recorded 2026-10-23:**

- **Licence.** `@anthropic-ai/claude-agent-sdk` is licensed under Anthropic's Commercial Terms of Service (https://www.anthropic.com/legal/commercial-terms), with the Privacy Policy and data usage policies its README links. Accepted by the maintainer for this dependency. It is not an open-source licence; the SDK is pinned to an exact version and each upgrade is a deliberate pull request.
- **Security.** `docs/security.md` rule 6 is reworded for trust boundaries and subagents, and section 9 records the accepted risk of in-session enforcement in Factorial-owned code.
- **Spike models.** Claude Sonnet 5.5 (`eu.anthropic.claude-sonnet-5-5`) as the primary candidate and Claude Haiku 5.5 (`eu.anthropic.claude-haiku-5-5`) as the cheap comparison, both measured against GLM 5.3 Flash on the Harness.

**Done when:** the foundation stack is updated, the use-case form is on file, and `InvokeModelWithResponseStream` on `eu.anthropic.claude-sonnet-5-5` from a principal under the agent boundary succeeds in `eu-west-1`.

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
- The run: `query(prompt, options)` with `cwd: "/workspace"`, `permissionMode: "bypassPermissions"`, `allowDangerouslySkipPermissions: true`, `settingSources: []`, `tools` listing exactly the built-ins the role may use, `model` from the process environment (set on the Runtime version, never from the request), `systemPrompt` from `prompts/<role>.ts` (ported from the harness blocks in `templates/20-agent.yml`), `maxTurns` and `maxBudgetUsd` from the environment, `agents` from `agents.ts`, `hooks` from `hooks.ts`, and `env` built from a short allow-list of the process environment plus `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_HAIKU_MODEL` (from `FACTORIAL_MODEL` and `FACTORIAL_BACKGROUND_MODEL` on the Runtime version), `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=4`.
- Every SDK message is appended to `/workspace/.factorial/transcript.jsonl` as it arrives and the result message to `/workspace/.factorial/result.json`, so a dropped stream loses nothing and `attach` and `status` have something to serve.
- Hooks in phase 1: `PreToolUse` denies `Edit`, `Write` and `Bash` calls whose path arguments resolve outside `/workspace`, and denies `Bash` invocations of `git push`, `gh auth` and `gh api` with a reason the model can read. These are a constraint on what a prompt injection can drive, not the access gate, as `docs/security.md` says.
- `agents` in phase 1: `explore` only (read-only: `Read`, `Grep`, `Glob`; `model` from `FACTORIAL_EXPLORE_MODEL`; `maxTurns` 30). The plan subagent arrives in phase 3.
- Web search: an in-process MCP server (`createSdkMcpServer`) with one `web_search` tool that signs a request to the AgentCore web search gateway with the execution role and returns the results as text. It replaces the harness's `@web-search/...` tool and is allowed to the builder only. The host's AWS SDK client is the only thing that signs; the model sees a tool, not a credential.
- Tests: the server contract (ping states, run and attach, 409), the hook decisions, the environment allow-list, and the mapping of result subtypes to outcomes, all without a model.

**Recorded with PR 3 (2026-10-23):**

- `attach` takes `after`, the number of the last message the caller has; every streamed message carries its number as the SSE `id`, so the invoker resumes without gaps or repeats.
- The `PreToolUse` hook checks the target path of `Edit`, `Write` and `NotebookEdit`, and also denies writes under `/workspace/.claude`, the SDK's own files. It does not parse paths out of `Bash` commands, which cannot be done reliably; there the non-root user and file ownership are the constraint.
- **Privilege separation** (replaces "`USER agent` is the last instruction" in 1.1): the host process runs as root and starts Claude Code as `agent` through `agent-runtime/claude-as-agent` (`setpriv` with no-new-privileges and an empty bounding set), so the model cannot signal, trace or reconfigure the host. The transcript and `result.json` move from `/workspace/.factorial` to `/var/lib/factorial`, root-only; PR 5 and PR 6 read them there, as root, through the command API. The host refuses to start unless it is root.
- **Models by purpose** (2026-10-23): `FACTORIAL_MODEL` is the role's main loop (Sonnet 5.5 for the builder), `FACTORIAL_EXPLORE_MODEL` the `explore` subagent (Haiku 5.5) and `FACTORIAL_BACKGROUND_MODEL` the SDK's background calls (Haiku 5.5). They are named by purpose, not size, so moving the builder to Opus is one value. A local run with Sonnet as the builder showed the `explore` turns on Haiku, `modelUsage` reporting both profiles separately, and the SDK's `Grep` working in the image without `rg`. The execution role in PR 4 allows every profile these name.
- `quiet` is bundled from `agent-environment/tools` into the image by the host's esbuild build, so the image's build context stays `agent-runtime/`.
- npm installs both the glibc and the musl Claude Code binary on linux-arm64; the Dockerfile removes the musl one (about 270 MB). The image is about 1 GB.
- The local check ran the image against Claude Haiku 5.5 on Bedrock with 15-minute federation credentials limited to that model and the web search gateway, rather than a stub provider: web search, a write, the `git push` denial, `status`, `attach` and the second-run 409 all behaved as designed, for $0.0023. After the privilege separation, a second run confirmed the model's shell is `agent`, cannot signal the host and cannot open `/var/lib/factorial`.
- Phase 0's last check (a Sonnet 5.5 stream under the agent boundary) moves to PR 4's first hand invocation, which makes that call under the real execution role.
- PR 4 must: run `npm run build -w @factorial/agent-runtime` before the image build; include `agent-environment/tools`, `packages/agent-runtime`, `packages/log`, `packages/artefacts`, `agent-runtime/` and both lockfiles in the image tag; and grant image pull on `repository/factorial/agent-runtime` (the `factorial-agent-runtime` policy names only `agent-environment` today).

**1.3 The agent stack** (`templates/20-agent.yml`)

**Recorded with PR 4 (2026-10-23):**

- **Foundation change after all.** CloudTrail shows CloudFormation's direct AgentCore creates carry the `aws:cloudformation:*` tags, and the execution role allowed only `Project` when tagging a new runtime (enough for a harness's own runtime). `AgentCoreRuntimeTagOnCreate` now also allows the three stack tags, from a `factorial-` stack. A human deploys the foundation before this PR merges.
- **Wall-clock limit.** `maxLifetime` (14,400 s) is longer than `BuildTimeoutSeconds` (7,200 s) and the SDK has no time limit, so the host aborts at `FACTORIAL_MAX_DURATION_SECONDS` (6,600, as the harness's `TimeoutSeconds`) and reports the run `incomplete` with `stopReason: max_duration`.
- **Limits:** `FACTORIAL_MAX_TURNS=150` (the harness's `MaxIterations`) and `FACTORIAL_MAX_BUDGET_USD=10`, chosen as enough for a reasonable task on Sonnet with caching.
- The role's model grants are two statements: `InvokeModel*` on the Sonnet and Haiku EU inference profiles, and on their foundation models in any region only through those profiles (`bedrock:InferenceProfileArn`). The trust policy is limited to `runtime/factorial_builder-*`.
- The promotion step promotes only a `READY` runtime version and fails if there is none.

- Parameter `AgentRuntimeImageTag`, passed by the deploy workflow like `AgentImageTag`.
- A new block, in the one-block-per-role layout:
  - `BuilderRuntimeRole`, named `factorial-agent-builder`, trusting `bedrock-agentcore.amazonaws.com` with the source-account condition, carrying `Factorial-AgentPermissionsBoundaryArn`, with `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the builder's inference profile ARN and its foundation-model ARNs (one statement per model the version may use, which is how the model is pinned), `bedrock-agentcore:InvokeGateway` and `InvokeWebSearch` for the web search tool, the existing `factorial-agent-runtime` managed policy for image pull, logs and tracing, and nothing else: no model key.
  - `BuilderRuntime`, `AWS::BedrockAgentCore::Runtime`, `AgentRuntimeName: factorial_builder` (the Harness of the same name is a different resource type and ARN; the name survives the cut-over), `ProtocolConfiguration: HTTP`, `NetworkConfiguration.NetworkMode: PUBLIC`, `LifecycleConfiguration` of 900 and 14,400 seconds as the Harness has, and `EnvironmentVariables` for `FACTORIAL_ROLE=builder`, `FACTORIAL_MODEL=eu.anthropic.claude-sonnet-5-5`, `FACTORIAL_EXPLORE_MODEL=eu.anthropic.claude-haiku-5-5`, `FACTORIAL_BACKGROUND_MODEL=eu.anthropic.claude-haiku-5-5`, `FACTORIAL_WEB_SEARCH_GATEWAY_URL`, `FACTORIAL_MAX_TURNS`, `FACTORIAL_MAX_BUDGET_USD`. These are part of the immutable version, and the role's IAM statements name the same models, so "model fixed on the version" holds twice over. `AWS_REGION` is reserved and set by the service.
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

**Recorded with PR 5 (2026-10-24):**

- **Phase 0 closed by PR 4's hand invocation (2026-10-23).** Sonnet 5.5 streamed under `factorial-agent-builder` and the agent boundary: success in 3 turns for $0.041, with 9,633 cache-read tokens, so prompt caching works on Bedrock in `eu-west-1` (open question 3, first half). `status`, `attach` and the second-run 409 behaved as designed on the deployed runtime.
- **Usage accounting (open question 7).** Summed streamed assistant messages undercount: a message carries its usage from the start of the response, before the output is counted (47 output tokens summed against 806 in `modelUsage` on a run with an `explore` call). The ledger's totals therefore come from the result's `modelUsage`, which covers subagents; the streamed calls give the call count and per-call input sizes, and are the fallback for a run stopped before its result.
- **Reconnect checked live.** A first stream cut after three messages was re-attached with `after: 3`; all 19 messages arrived once, in order.
- The invoker reads `TARGET` (`harness` by default) with `RUNTIME_ARN` and `RUNTIME_QUALIFIER`, and refuses a runtime that is not `factorial_<role>-…`. Stop reasons on a runtime are the result subtype, `max_duration` or `host_error`; `success` is complete, a turn, budget or time limit is incomplete (exit code 3, the rounds path), and anything else is an error. The host's `status` decides when it can be read.

**Recorded with PR 6 (2026-10-24):**

- `sessionTarget` sends the builder's commands, and its clean room, to `BUILDER_RUNTIME_ARN` when `BUILDER_TARGET=runtime`; the planner and reviewer stay on their harnesses. CollectPlan and ContinueBuild hand `/workspace` to `agent` after their last seeding write.
- Collect's inspection, leftover commit, bundle and session-file export all run as `agent`, through `setpriv` with the wrapper's restrictions rather than `runuser` (no PAM, and the same drop as the host's). Reading the files as `agent` goes beyond 1.6, which kept them root: a planted symlink then reaches only what the model could already read. Checked in the image: no `safe.directory` complaint (open question 4), and the leftover commit's objects stay agent-owned.
- **Found on the first spike item (#108):** the Runtime's command API splits the command into words as a shell would, honouring quotes, but runs the first word as a program; the harness ran it through a shell. `runCommand` sends `bash -c '<script>'` to a Runtime (`commandFor`). Checked on the deployed Runtime with the seeding, `chown`, `asAgent` and inspection scripts.
- Collect does not read `/var/lib/factorial`: the invoker gets the run from the stream and `status`, so nothing outside the host reads the record.
- `BuilderTarget` (a template Mapping since the spike's first flip: as a parameter, the deploy kept the stack's existing `harness` and ignored the new default) reaches the Lambdas as `BUILDER_TARGET` and the Build state as `TARGET`, `RUNTIME_ARN` and `RUNTIME_QUALIFIER`. The session-command policy gains `InvokeAgentRuntimeCommand` (only) on the builder Runtime and its endpoints.

**Recorded with the first spike item (#108, PR #113, 2026-10-24):**

- Sonnet 5.5 finished in one session: 12 turns, 131 seconds, $0.081, 89% of input tokens from cache, one stream with no re-attach. The pull request was accepted.
- The report was the weak part: the builder never read `plan.json` or `notes.md`, and wrote a one-line `summary.md` with no `## Plan steps`, although both prompts ask for it. A `Stop` hook in the host (`packages/agent-runtime/src/report.ts`) now sends the builder back, at most twice, until the section has a line for every step id in the plan; the host reads the two files without following links, capped, and returns only step ids. Checked locally on Haiku 5.5: a run told to write "Done." was sent back once and then reported each step, including one it skipped.
- The builder could not run `cfn-lint`, the last step of `npm run ci`, and had no `python3`. The image now has both, `cfn-lint` at CI's version with every dependency pinned by hash (about 200 MB more).

**Recorded with the forced-rounds runs (#116, #120, 2026-10-24):**

- At 10 turns, #116 finished in 5 (PR #118); Sonnet batches its work heavily, so forcing a round needed a limit of 3.
- At 3, #120 stopped at its limit with the work committed, but failed instead of continuing. At a turn or budget limit the SDK delivers its `error_max_turns` result and then throws ("Claude Code returned an error result"). The host recorded the throw as a host error, so the stream said `host_error` while `status` said `incomplete`, and the invoker's agreement check failed closed (`outcome_mismatch`, exit 1, no ContinueBuild). The host now lets an error result decide the outcome when the SDK throws after it. A throw after `success`, or with no result, still fails.

- With that fixed, #122 continued into round 2, then failed in Collect, which pushed every round as if it were the first: from the original base commit, onto a branch that must not exist yet. The ledger shows no item had reached round 2 before, on either target, so the rounds path had never completed. ContinueBuild now returns the round's start (the commit, whether the branch exists, whether earlier rounds pushed), the state machine carries it as `$buildStart`, and Collect bundles and pushes only that round's commits onto the branch as it stands. A round with no new commits keeps the earlier rounds' pushed head. A resumed attempt's first push, onto its existing branch, had the same fault and is fixed with it.

- After that fix, #122 ran again (2026-10-25) as a new attempt: its earlier attempt had failed inside SaveWork, so it had no saved work to resume from. Round 1 wrote the change and its leftover commit was pushed to a new branch; rounds 2 to 6 each spent their 3 turns reading the notes, the diff and the test, and running CI, and pushed nothing new. SaveWork kept round 1's head every time, and the sixth round ended the item at `MaxBuildRounds` with the branch saved: the rounds path works end to end. Two findings: a fresh session needs more than 3 turns to pick up where the last one stopped, as expected; and the failure comment reported "0 commits", the last round's own count, for a branch holding round 1's commit. It now leaves the count out when the round pushed none. The turn limit is back at 150.

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
3. Run the same issue on Haiku 5.5 (a Runtime version with a different `FACTORIAL_MODEL` and matching IAM) and on GLM 5.3 Flash on the Harness (`BuilderTarget` back to `harness`). Run Sonnet 5.5 once more with `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` to see compaction fire.
4. Record rounds, calls, input and output tokens, cache reads, cost, wall time, whether the pull request was accepted and how much human rework it needed, as a **Spike results** section in `docs/harness-vs-runtime.md`, and set `BuilderTarget` back to `harness`.

**Gate for phase 2:** the Runtime completes the item in one session where the Harness needed rounds, at a cost per accepted pull request no worse than twice Flash's, with no finding against the security mitigations. If the gate fails, the Runtime block is removed and the record says why.

**Result (2026-10-25):** passed on #87 (PR #128); the numbers, the runs not made and the decision are in **Spike results** in `docs/harness-vs-runtime.md`. `BuilderTarget` stays `runtime` for phase 2.

### Phase 2: cut the builder over

- `BuilderTarget` defaults to `runtime`. The builder Harness block, its `live` endpoint and the builder's share of the LiteLLM configuration are removed from `templates/20-agent.yml`; the `factorial-agent` role loses its model-key statement. The planner and reviewer keep theirs.
- Web search stays on the AgentCore gateway for every role, reached by the builder through the host's in-process tool; the gateway is not removed in any phase.
- `maxTurns` and `maxBudgetUsd` are set from the spike's numbers. `SaveWork` and `ContinueBuild` stay as the safety net for an exhausted limit; `MaxBuildRounds` can come down.
- `CLAUDE.md` **Current stage** and the **Agent roles**, **Secrets** and **Language** conventions, `docs/current-stage.md` and `docs/system-diagram.md` are updated in the same pull request, as the stage rule requires. The **Language** convention becomes: TypeScript for all code Factorial owns, including the agent host process; the agent's loop is the SDK's, and its definition (prompt, tools, subagents, limits, model) is versioned by the Runtime version.
- `docs/harness-vs-runtime.md` status line changes to "superseded for the builder; see `docs/agent-sdk-plan.md`".

**Two pull requests, not one (2026-10-25).** The orchestration stack imports the builder Harness's exports, and CloudFormation will not delete an export that another stack still imports; the agent stack deploys first. So 8a stops the orchestration stack using the builder Harness, and 8b, once 8a is deployed, removes the Harness block.

- **8a:** the `BuilderTarget` switch goes rather than defaulting to `runtime`, since the Harness it would switch back to is about to be removed: `sessionTarget` always sends the builder and its clean room to the Runtime, Build passes `TARGET=runtime` and no Harness ARN, and the Lambdas' and invoker's grants on the builder Harness go. `MaxBuildRounds` becomes the template mapping `Builder.MaxRounds`, 3 (a parameter's changed default would not reach the stack), and `FACTORIAL_MAX_BUDGET_USD` comes down to 5; `maxTurns` stays at 150. The docs above are updated here, since this is the change a work item sees.
- **8b:** the builder Harness, its `live` endpoint, the `factorial-agent` role (used only by that Harness, so removed whole rather than losing a statement), the `MaxIterations` parameter, and the `Builder*` Harness and `AgentRoleArn` outputs. The planner's block takes over the explanations the others pointed to in the builder's (cfn-lint, LiteLLM, constants over parameters, gateway tool names, the one-line summarisation prompt). The builder's harness prompt survives at `stage-0-harness`. The foundation's references to `role/factorial-agent` are left for the phase 4 clean-up, since a human deploys that stack.

### Phase 3: the planner subagent, then the reviewer Runtime

The planner moves before the reviewer (changed 2026-10-25; the first version of this plan had it last). The spike runs a Sonnet builder from a plan written by GLM 5.3 Flash on the Harness, so the gate measures the builder alone, with a planner that can only hold it back. The full benefit needs the plan in the builder's session: no separate stage, no second clone and no wait of several minutes before the build starts. The plan is a subagent, so what it reads stays in its own context and only its reply reaches the builder; the builder still works from `plan.json`, and its window is not filled by the planner's reading. The SDK's `plan` permission mode, which is how Claude Code plans locally with the main agent restricted to read-only tools, would carry the planner's context into the build; it is not used here, and would be the change to make if that proves to matter. The reviewer is advisory, so moving it changes no outcome and can wait.

**3.1 Planner into the builder** (straight after phase 2)

- `agents.plan` in the host process: `Read`, `Grep`, `Glob` only, no `Bash`, `maxTurns` 40, `model` inherits. The builder's system prompt says to run it first and write `/workspace/plan.json` and `/workspace/plan.md` from its report before any edit; the prompt for the plan subagent is ported from the planner's harness block.
- A `PostToolUse` hook on `Write` to `/workspace/plan.json` validates it with `@factorial/plan` and, if invalid, returns the errors so the builder re-plans; after two failures the hook stops the run with `decision: "block"` and a reason, which the invoker reports as `invalid-plan`.
- `collect.ts` reads `plan.json` and `plan.md` out of the builder's session, validates again with the same package, stores them under `plan/` and records `planSize`, so the artefacts and the ledger fields are unchanged. A stored plan that fails validation ends the run as `invalid-plan` whatever happened in the session.
- The state machine loses `Plan`, `CollectPlan` and `PlanAccepted`; `Prepare` goes straight to `Build`. `ContinueBuild` reads the plan from the artefact store as it does now. The `planAttempt` variable goes. The lineage fields stay for the later feature where one trigger fans out into child items; that will need a plan state again and is out of scope here.
- The planner Harness block, its role and the planner's share of the LiteLLM configuration are removed; the web search gateway stays.


**Two pull requests, as in phase 2 (2026-10-25).** The orchestration stack imports the planner Harness's exports. So 9a moves planning into the builder and stops the orchestration stack using the planner Harness, and 9b, once 9a is deployed, removes the planner Harness block, its role and the planner's share of the LiteLLM configuration. 9a differs from the bullets above in five places:

- **The subagent's tools.** Read, Grep and Glob, plus web search, which the planner harness had, and `Write`, which the host's `PreToolUse` hook limits to `/workspace/plan.json` and `/workspace/plan.md`. The subagent writes the plan itself rather than replying with it for the builder to copy, so the builder does not spend output on the copy or change the plan in passing, and the plan hook's errors reach the subagent that wrote the plan.
- **Who reports `invalid-plan`.** Collect does, and nothing in the invoker. After the second rejection the host denies every further tool call (rather than `continue: false`, whose result subtype the SDK does not document), so the run ends as a finished one; Collect then finds no valid plan, stores what there is, pushes nothing and fails with `InvalidPlan`, which the state machine reports as before. SaveWork stores the plan whatever its state and saves the work regardless.
- **The `Stop` hook checks the plan too**, so a plan written through `Bash` rather than `Write` cannot slip past the `PostToolUse` hook.
- **ContinueBuild seeds only a valid stored plan.** A round that stopped before the builder wrote one leaves none, and the next round plans first.
- **The invoker's planner role goes in 9a**, with `planPrompt` and `PLAN_ATTEMPT`, since nothing starts it once the Plan states are gone.

**Gate:** two real items through the merged graph, each producing a valid stored plan, a tested branch and a review. One of them is #87 again, recorded beside the spike's run and the Harness's #92, so the record shows what moving the planner added.

**Result (2026-10-26): passed.** Both items went from label to pull request with no human step, each with a plan valid on its first write, one build round, passing tests and an approving review (two low findings each). #87 could not be one of them: the spike's PR #128 had already merged it, so a rerun would build on a `main` that has the change. Measured against the spike's records instead:

| | #125, `WebFetch` for the builder (PR #138) | #140, subagent usage in `usage.json` (PR #141) |
|---|---|---|
| Plan | 4 steps, 5 files | 3 steps, 7 files |
| Plan subagent | 37 s, 14 tool calls, 6 model calls, 86,952 input tokens (32% of the run's) | 68 s, 13 tool calls, 4 model calls, 59,372 input tokens (17%) |
| Build | 182 s, 11 turns, $0.23 | 210 s, 13 turns, $0.23 |
| Label to pull request | about 7 min | about 9 min |

Against the spike's small items ($0.06 to $0.14 with a GLM plan already written) and #87 ($1.05), planning in the session added little cost. Both items needed a change before merging, and both changes trace back to Factorial or to the issue, not to the plan:

- **#125:** the plan left the plan subagent's `WebFetch` (the issue's step 5) as a follow-up; added by hand on the PR.
- **#140:** the issue took the Agent result's `totalTokens` and `usage` as the subagent's totals; they are its last call. The issue and #141 were corrected to sum the subagent's own calls.

Two fixes came out of the runs:

- **Foreground subagents (#139).** Claude Code started the plan subagent in the background by default, and on #125 the builder slept 90 seconds for a plan ready after 37. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` now makes subagents and commands finish before the builder continues; #140 ran that way.
- **Subagent usage (#141)** makes the plan subagent's share of a run visible in `usage.json` from the next run on, which the figures above had to be summed by hand to give.

**Consequences (2026-10-25).** Planning inside the builder's session is consistent with `docs/security.md` section 3.4 (roles may share a session when neither judges or ships the other's output) and matches how Claude Code plans locally, with a read-only plan step before edits in one session. It also narrows four things, recorded here so they are decided rather than discovered:

- **The plan is the builder session's claim.** The subagent writes `plan.json` itself (see the 9a notes above), but the builder can still change it afterwards: its prompt says not to, and nothing enforces that. So the stored plan is what the session left, not evidence of what the planner wrote. The transcript under `/var/lib/factorial` holds both.
- **Planning is no longer a role with its own provider.** The plan subagent runs on a Bedrock model the SDK can call, on the builder's execution role. A different Bedrock profile for planning is one value in `agents.plan` plus an IAM statement, and would also make the planner's cost visible on its own in `usage.json`, which `model: inherit` hides inside the builder's. A planner on another provider, as the Harness allowed through LiteLLM, is not available without a separate role.
- **No pause between plan and build.** A human or requester approval of the plan before building (Claude Code's local gate) would mean ending the session after the plan and re-seeding it through ContinueBuild, which works, rather than holding a Runtime session open.
- **Decomposition needs a plan stage again.** Planning before any one repository or branch exists (one trigger fanning out into child items, the lineage fields' purpose) cannot run inside a builder session. `contracts/plan/v1/` serves both that stage and the subagent, so it must not acquire in-session assumptions.

**3.2 Reviewer**

- `FACTORIAL_ROLE=reviewer` on a second Runtime, `factorial_reviewer`, from the same image, with role `factorial-agent-reviewer` re-created for the Runtime trust, and a `live` endpoint.
- Tools: `Read`, `Grep`, `Glob` and `Bash`; a `PreToolUse` hook denies every `Edit` and `Write` except `/workspace/review.json`, and denies `Bash` commands that write (`>`, `tee`, `git commit`, `git checkout`, `npm install`). The reviewer's system prompt is ported from its harness block.
- The state machine's Review state passes `TARGET=runtime` and the reviewer's Runtime ARN; PrepareReview and CollectReview address the Runtime through `session.ts`. The reviewer Harness block, the LiteLLM configuration and the `ModelApiKey` credential provider go (the `MaxIterations` parameter, used only by the builder Harness, went in 8b).

**Two pull requests, as in phases 2 and 3.1 (2026-10-26).** The orchestration stack imports the reviewer Harness's exports. So 10a adds the reviewer Runtime and moves Review, PrepareReview and CollectReview to it, and 10b, once 10a is deployed, removes the reviewer Harness, the `ModelApiKey` credential provider, the LiteLLM configuration and the parameters only they use. 10a differs from the bullets above in five places:

- **The role is kept, not re-created.** `factorial-agent-reviewer` keeps its logical id and name (a new logical id with the same `RoleName` would fail to create), gains the Bedrock statements and loses its token-vault and workload-identity statements in 10a: the Runtime's shell shares the role, so it must not be able to fetch the Z.ai key, and nothing invokes the Harness any more. A run still in flight on the previous state machine version during the deploy would have its review fail, which is advisory. 10b narrows the trust to `runtime/factorial_reviewer-*`.
- **Tools.** Read, Grep, Glob, Bash, and Write and Edit limited to `/workspace/review.json`. The `PreToolUse` hook's Bash rules are matched with quoted text removed, so `grep -n '=>'` or `git grep 'git commit'` stay allowed, and deny redirection to a file (other than `/dev/null` or between streams), git commands that change state, installs, file-changing commands in command position (`tee`, `rm`, `mv`, `cp`, `sed -i` and the like), and `bash -c`, `eval`, `python -c` and `node -e`, which would hide one inside quotes. As for the builder, this narrows what an injection can drive; CollectReview reading one validated file is the gate.
- **A `Stop` hook checks the review**, as the builder's checks its report: while `review.json` is missing or fails `@factorial/review`, the reviewer is sent back with the errors, at most twice. #87's first harness review read until its step limit and wrote nothing.
- **Model and limits.** Sonnet 5.5 for the loop and Haiku 5.5 for background calls, through the same EU profiles and pinned by the role as the builder's are; no subagents and no web search. 60 turns, $2 and 900 seconds, under `ReviewTimeoutSeconds` (1200). The prompt loses the GLM-era read and step budgets.
- **Ownership.** PrepareReview hands `/workspace` to the `agent` user after its last command, and CollectReview reads `review.json` as `agent`, as Collect does for the builder.

10b removes the reviewer Harness and its `live` endpoint and outputs, the `ModelApiKey` credential provider, the shared policy's secret and `agent-environment` image grants, and the `AgentImageTag`, `ModelApiBase` and `ModelApiKeySecretName` parameters, and narrows the reviewer role's trust to `runtime/factorial_reviewer-*`. The deploy workflow stops passing `AgentImageTag`; the `agent-environment` image build and the Harness promotion loop stay for phase 4, which removes them with the repository. The shared policy keeps its description, which still says harness, since changing it replaces the policy and the fixed name collides (#130).

**Gate:** a review that validates against `contracts/review/v1/` on a real item; the reviewer is advisory, so nothing more.

### Phase 4: retire the Harness and tidy the record

- `templates/20-agent.yml` holds two Runtime blocks and the shared policy, and nothing Harness-shaped. The `agent-environment/` image is retired; the Runtime image is the only agent image. The deploy workflow's Harness build and promotion loops go.
- Foundation (human deploy): the agent boundary loses the token-vault and workload-identity statements; the runtime boundary's deny list drops the Harness actions; the Z.ai secret and the `factorial/agent-environment` repository are deleted by hand.
- `CLAUDE.md` **Target architecture** says "Agents: Claude Agent SDK on AgentCore Runtime" with the version rule restated; **Fixed from day one** is unchanged. `docs/security.md` §3.4 is rewritten for subagents and the Runtime, with the accepted-risk entry from phase 0 now in force. `docs/architecture-principles.md` is checked for any principle that named the Harness.
- The invoker's Harness path, `HARNESS_*` variables and the `@aws-sdk/client-bedrock-agentcore-control` harness calls are removed.
- Tag `main` as `stage-1-agent-sdk` and add a one-line pointer from `stage-0-harness` in `docs/current-stage.md`.

**Two pull requests (2026-10-26).** The deploy workflow reads the `factorial/agent-environment` repository's export and the deploy role still holds the Harness promotion actions, so the foundation can change only after a workflow that no longer needs them is on `main`. 11a removes the Harness code paths, the `agent-environment/` image and the workflow's Harness build and promotion, and rewrites the docs; 11b, once 11a is deployed, is the foundation clean-up, deployed by a human, then the hand deletions and the tag. 11a also:

- **Moves `quiet`** from `agent-environment/tools` to `packages/agent-tools`, since the Runtime image bundles it and the directory it lived in is gone.
- **Renames the Lambdas' `HARNESS_QUALIFIER` to `RUNTIME_QUALIFIER`**, and the state machine stops passing `TARGET`, which the invoker no longer reads.
- **Drops the invoker's delta joining.** The transcript buffer joined the Harness's streamed text deltas so a split credential was redacted whole; the host sends whole SDK messages, so there are no deltas to join.
- **Supersedes `docs/security.md` section 8** (root in the session) rather than deleting it, and records the reviewer's Bash denylist as a known gap in section 7.

11b differs from the bullets above in three places:

- **The runtime boundary keeps its Harness deny statements.** It allows `bedrock-agentcore:*`, so dropping `CreateHarness` and the endpoint actions from its deny list would let a bounded role start an agent of its own if its policy ever allowed it. Denying actions on a resource type Factorial no longer uses costs nothing.
- **The agent boundary's model statement is scoped** to `eu.anthropic.*` inference profiles in the account and `anthropic.*` foundation models, closing the gap `docs/security.md` recorded (every model allowed); `ApplyGuardrail` is limited to the account's guardrails. Each execution role still names its own profiles.
- **`role/factorial-agent` stays** in the execution role's agent-role rules. No role has that name since 8b, and keeping it in the deny list is the stricter choice.

Deploying 11b removes the `factorial/agent-environment` repository, which CloudFormation can only delete when it is empty, so its images are deleted by hand first; the Z.ai secret is deleted by hand after. Nothing in the foundation's deny statements depends on either.

## 4. Pull requests, in order

| # | Phase | Contents | Depends on | Done when |
|---|---|---|---|---|
| 1 | 0 | This plan; corrections in `docs/harness-vs-runtime.md`; README link | tag `stage-0-harness` | Merged |
| 2 | 0 | Foundation: ECR `factorial/agent-runtime`; `docs/security.md` accepted-risk entry and rule 6; licence statement; `docs/bootstrap.md` step for the Bedrock use-case form | Use-case form submitted | Foundation deployed by hand; a test `InvokeModelWithResponseStream` succeeds under the agent boundary |
| 3 | 1 | `agent-runtime/` image and `packages/agent-runtime/` host process with tests; SDK pinned at an exact version | 2 | `npm run ci` passes; the image runs locally with a stub provider and answers `/ping` and `/invocations` |
| 4 | 1 | Agent stack Runtime block; deploy workflow build and promotion; `AgentRuntimeImageTag` | 3 | Deploy succeeds; `live` endpoint `READY`; a hand invocation with a trivial prompt returns a result message |
| 5 | 1 | Invoker `TARGET=runtime` path, transcript and usage mapping; invoker IAM | 4 | Unit tests on message mapping; a hand run records `usage.json` with cost |
| 6 | 1 | Orchestrator session targeting, `chown` and `runuser` in Prepare, ContinueBuild and Collect; state machine `BuilderTarget` parameter | 5 | Default `harness`: the existing pipeline is unchanged on a real item |
| 7 | 1 | Spike runs; **Spike results** in the record; gate decision | 6 | Numbers recorded; decision written |
| 8a | 2 | Builder cut-over: `BuilderTarget` removed, builder Harness unused; limits from the spike; docs and `CLAUDE.md` stage update | 7 passed | A real item through the Runtime |
| 8b | 2 | Builder Harness block, `factorial-agent` role and their outputs removed | 8a deployed | Deploy succeeds; the next item unchanged |
| 9a | 3 | Plan subagent, plan hook, Collect validation; Plan states, CollectPlan and the invoker's planner role removed | 8b | Two real items through the merged graph, one of them #87 |
| 9b | 3 | Planner Harness block, its role and its LiteLLM share removed; the reviewer block takes over the explanations; the foundation's planner references wait for phase 4 | 9a deployed | Deploy succeeds; the next item unchanged |
| 10a | 3 | Reviewer Runtime; Review, PrepareReview and CollectReview moved to it | 9b | A real review validated from the Runtime |
| 10b | 3 | Reviewer Harness, model key, LiteLLM and their parameters removed | 10a deployed | Deploy succeeds; the next item unchanged |
| 11a | 4 | Harness code paths, image and workflow loops removed; `quiet` moved; docs rewrite | 10b | `npm run ci`; deploy; the next item unchanged |
| 11b | 4 | Foundation clean-up (human deploy); Z.ai secret and `agent-environment` repository deleted by hand; tag `stage-1-agent-sdk` | 11a deployed | Foundation deployed; record updated |

Pull requests 3 to 6 can be reviewed independently but deploy in order; each is small enough to read in one sitting. Nothing before 8 changes what a work item sees.

## 5. Open questions, settled in phase 1

1. **Streaming duration.** How long one `InvokeAgentRuntime` SSE response may last before the service closes it. The host's `attach` action exists so the answer does not block the spike, but the invoker's reconnect loop is only exercised if it is needed.
2. **Web search.** That the in-process gateway tool works from the SDK and the builder uses it when it should. If the SDK's MCP path is awkward, the fallback is `WebFetch` on URLs the builder already knows, which Claude Code allows on Bedrock.
3. **Prompt caching.** That cache-read tokens are non-zero on `eu.anthropic.claude-sonnet-5-5` in `eu-west-1`, and whether the 200K window with earlier compaction or the 1M window with later compaction is cheaper per item.
4. **User and ownership.** That `chown` after Prepare's root-run clone is enough, and that git inside `/workspace/repo` as `agent` raises no `safe.directory` complaint.
5. **Cold start and image size.** The SDK's native binary and `node_modules` add to the image; measure the session start time against the Harness's and note it beside the token numbers.
6. **Disk.** The SDK's transcript under `CLAUDE_CONFIG_DIR` and Factorial's own under `/var/lib/factorial` both grow with the run; confirm the microVM's ephemeral disk holds a 150-call run with headroom.
7. **Usage accounting.** Whether per-call usage on assistant messages, summed, matches the result's `modelUsage`; the ledger keeps whichever is the sum over every model call including subagents.
8. **Rate limits.** What the account's Bedrock token-per-minute quotas are for the EU profiles and whether a four-wide subagent fan-out hits them.

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The model drifts from the version | Pinned twice: `FACTORIAL_MODEL` on the Runtime version, passed as `model` by the host code and never read from the request, and the execution role allowed only that inference profile; `usage.json` records the model the SDK reports |
| Bedrock lacks Claude Code's web search and may lag new models | The gateway tool covers search; the 5.5 models are already active in `eu-west-1`; a new model is a Runtime version plus an IAM statement |
| The SDK moves fast and bundles the CLI | Pinned to an exact version in `package.json`; updates are deliberate pull requests that re-run the spike item; the changelog is read before a minor |
| In-session enforcement is Factorial's code | Root-owned host files, non-root agent user, `settingSources: []`, agents and hooks in code, caps in the host; the outer rules stay the gate (`docs/security.md`) |
| Cost per token rises with Sonnet | `maxBudgetUsd` per item; the spike measures cost per accepted pull request, which is the number that decides |
| A run outlives the stream or the session | `HealthyBusy` keeps the session alive; the transcript and result are on disk; `attach` and `status` recover them; `maxLifetime` and `maxTurns` end a run before Step Functions does |
| Subagent fan-out | Depth 1, concurrency 4, per-agent `maxTurns`, the stall watchdog, and one budget for the whole session |
| Ownership mismatches between root commands and the agent user | `chown` after seeding, `runuser` for git in the model's repository, the clean room untouched |
| The Harness is removed before the Runtime is proven | Phase 1 kept both deployed behind `BuilderTarget` until the spike passed; from phase 2, reverting 8b and then 8a restores the builder Harness; `stage-0-harness` is the known-good state |

## 7. Rollback

Until phase 4, every phase is reversible by deploy: reverting phase 2's two pull requests, 8b first, returns the builder to the Harness; the reviewer and planner blocks are removed in their own pull requests and can be restored from the tag. After phase 4, the Harness is gone from `main`, and a return means reverting to `stage-0-harness` and re-creating the Z.ai credential. That is the point at which the move is permanent, and it comes only after three real items have gone through the new graph.
