# Decision: AgentCore Harness over Runtime

**Date:** 2026-10-22. **Status:** decided, stay on Harness. **Revisit:** see the last section.

A decision record, as principle 6 in `docs/architecture-principles.md` asks for: the question, the evidence, the options, the decision and its consequences. It extends the one-paragraph decision in `docs/design-plan.md` §3.2 with the evidence from the first week of runs.

## The question

Factorial's agents are AgentCore Harnesses: the agent loop is AWS-managed configuration. AgentCore Runtime hosts a loop you write, with full control over the session and the context, the way Claude Code manages its own. Would moving some or all roles to Runtime, with context compaction and subagents under Factorial's control, cut token use and fix the problems seen so far? Or does the current design need optimisation, and are the problems mostly the model (GLM 5.3 Flash)?

## The evidence

### What went wrong, by cause

The ledger held 22 runs on 2026-10-22: 10 pull requests, 2 runs that timed out with no changes, and 10 failures.

| Cause | Runs | Harness-related? |
|---|---|---|
| Orchestrator plumbing (token format, push errors, four Fargate ENI attachment failures, an inactive task definition, an ambiguous git ref) | 8 | No |
| Model wandering on early Flash runs: an hour of exploration without a commit (#4), installing browsers until a Z.ai 1214 rejection (#5) | 2 | No; fixed by the prompt (#14, #41) and reasoning effort |
| Z.ai rejecting the OpenAI chat-completions path mid-run (#17) | 1 | Provider; fixed by the LiteLLM configuration |
| Builder ran out of iterations with half the plan done (#87, PR #92) | 1 | Partly; see below |

No failure was caused by a limit of the Harness loop that Runtime would remove.

### Where the tokens go

The largest run, #87, on GLM 5.3 Flash (artefacts `e61eeb40-ce44-11f1-8234-692b51c98c23/1/`):

| Role | Calls | Input tokens | Served from cache | Context at the end | Stop reason |
|---|---|---|---|---|---|
| Planner | 42 | 1.97M | 92% | 74k | `end_turn` |
| Builder | 150 | 9.37M | 98% | 88k | `max_iterations_exceeded` |
| Reviewer | 40 | 1.65M | 94% | 52k | `max_iterations_exceeded` |

About $0.50 at Flash list price; about $4.40 on the flagship GLM 5.3. Issue #95 breaks the context down: roughly half of the builder's context and 80% of the reviewer's were file reads, led by whole-file `cat` of `plan.md`, `notes.md`, CLAUDE.md and source files. Cost is roughly calls × context, and caching already serves nearly all of the input, so the remaining levers are the number of calls and the size of each read.

The smaller runs the same week (#83: 62 builder calls, 1.83M tokens; #85: 66 calls, 1.25M) finished in one session. Every run since 2026-10-21 has been on Flash; the flagship ran only smaller items between 2026-10-17 and 2026-10-21, so there is no like-for-like comparison yet.

### What Harness and Runtime offer

Checked against the AWS documentation on 2026-10-22.

- **Context truncation.** The Harness applies its strategy (`sliding_window`, `summarization` or `none`) only when the history exceeds the model's context window. There is no threshold setting. With Flash's 1M-token window, summarisation has never fired and a session's context only grows. The sliding window is the only early cut, and it changes the prompt prefix each time it slides, which breaks caching (#29). This is the one Harness gap with no configuration answer.
- **Subagents.** The Harness has none, and offers no framework choice. Its nearest mechanism is the inline function tool: the stream pauses while the caller serves the tool call and sends the result back. The orchestrator could answer such a call by running another harness, but sessions belong to one runtime, so a delegate cannot see the builder's working tree.
- **Hooks.** Lambda, SNS or EventBridge targets before and after an invocation or a tool call; a Lambda hook can deny a tool call. They run under the harness's execution role, which is why Factorial does not use them as control signals (`docs/security.md`).
- **Step Functions.** The optimised InvokeHarness state supports Request-Response only, no `.sync` and no task token, so the Fargate invoker stays whichever primitive is used.
- **Runtime.** A container you write, in any language, behind an HTTP contract; the same microVM isolation, session command API, versioning and endpoints, filesystem options and per-second compute pricing as the Harness. Model selection, the Identity token vault for the model key, execution limits, truncation, streaming, skills and observability all become code you write and maintain. Sessions run for up to 8 hours.

## The options

1. **Stay on Harness and optimise.** Cut reads (#95), move repository conventions into a path skill (#96), keep rounds as the compaction mechanism (#98, PR #99), add the explorer stage (#54), and measure the model per role.
2. **Move the builder to Runtime** with a loop Factorial owns (TypeScript, or Strands on Runtime): threshold compaction, tool-output elision, subagents sharing the session filesystem, prompt-cache control.
3. **Move every role to Runtime.** Option 2 for the planner and reviewer as well.
4. **Move the builder to Bedrock Managed Agents.** OpenAI's Codex harness as a managed service, with the builder's commands running in an AgentCore Runtime. See the section below.
5. **Move the builder to the Claude Agent SDK on an AgentCore Runtime.** Claude Code's harness as a TypeScript library inside a Runtime container Factorial owns. See the section below.

## The decision

Option 1. The problems seen so far are plumbing, model discipline and read volume. None needs a different loop, and the one Harness limitation that matters, compaction below the model window, already has a substitute. If that gap is still open at re-evaluation, option 5 is the first to spike: it is generally available in `eu-west-1` today, and option 4 is in preview in US regions only.

Why not Runtime now:

- **The gains have Harness-compatible substitutes.** Claude Code's compaction is a summary the loop writes to itself. Rounds are the same idea with the summary (`notes.md` and the branch) as an artefact the orchestrator seeds into a fresh session, which fits principle 3 better: every hand-over is a stored file a human can read, and nothing is read out of the old session. Subagents mainly keep exploration out of the main context; the explorer stage does that in time rather than in space, and its output is a validated artefact rather than a tool result the builder trusts.
- **Runtime moves the loop into the security surface.** Model configuration, limits and the tool allow-list are enforced by the harness version today (`docs/security.md` §3). On Runtime they are enforced by code running inside the sandbox, which the builder can reach. The model key would be fetched by Factorial's own process in the session, giving up the verified property that a shell command in the session cannot read the secret.
- **It is bespoke where the managed service is adequate.** Principle 6 prefers the managed primitive. A loop Factorial owns is code Factorial must review in every pull request it raises against itself, and it reintroduces a second language if it is Strands.
- **Compute costs the same.** Runtime and Harness bill the same per-second CPU and memory; the token bill does not change with the primitive.

## Is it the model?

Partly. The pattern on Flash (an hour of exploration early on, whole-file reads, 150 calls for a six-step plan, the reviewer running out of its 40 iterations) is what a weaker model does, and the prompt changes closed only part of the gap. But token cost at Flash prices is cents per item; the real cost of a weaker model is incomplete runs, extra rounds and human rework, which is what principle 8 says to measure. The decision on the model is per role and should be made from a like-for-like comparison, not from the token bill.

## Consequences and actions

In order:

1. **#95 and #96.** Read rules in every prompt, `plan.json` only, conventions as a path skill. The cheapest change and probably halves the context.
2. **Reviewer limit.** The reviewer hit 40 iterations on #87. Raise the cap or cut what it reads before judging the review's quality.
3. **Model comparison.** Run a #87-sized item on GLM 5.3 and on Flash, and record calls, tokens, rounds and outcome against `planSize` on the ledger. Decide per role; the planner is about 15% of the tokens and benefits most from the stronger model.
4. **Explorer stage (#54).** The builder gets a context pack instead of reading the repository itself.
5. **Record the truncation facts.** The builder's prompt and the design record should say that the harness truncates only beyond the model window and that rounds are Factorial's compaction (#95 item 4).

## Bedrock Managed Agents

Evaluated on 2026-10-22 as a further option. Amazon Bedrock Managed Agents (BMA) runs OpenAI's Codex harness as a service: the model calls, the session and the context compaction happen service-side, and the agent's commands run in an execution environment the customer provides, either a self-hosted host or an AgentCore Runtime running `codex exec-server`. Sessions are durable and multi-turn. Skills are `SKILL.md` directories on the environment's filesystem; tools are STDIO MCP servers in the environment or an AgentCore Gateway. Requests are SigV4-signed, so no OpenAI key exists anywhere.

**What it would give Factorial**

- Compaction below the model window, managed by the harness. This is the one Harness gap with no configuration answer.
- A harness built for coding. The Codex loop's editing and tool discipline are a different class from the Strands shell and file tools, which is where Flash spends its calls.
- No third-party model key. The sandbox holds nothing the shell could exfiltrate, and the model is pinned by an IAM condition (`bedrock-mantle:Model`) on the session role, which is infrastructure enforcement.
- Completion the agent cannot forge: BMA reports the end of a turn service-side, as the Harness stream does today.
- A good fit with the design: BMA would be a new invoker mode for the builder only. The planner and reviewer stay on Harness, and the state machine, clean-room push, test and review stages are unchanged.

**Why it cannot be adopted today**

- Preview regions are `us-east-1`, `us-west-2` and `us-east-2`. Factorial is `eu-west-1` by convention.
- OpenAI models only (`openai.gpt-5.6-luna` in the preview). AWS publishes no price sheet for it, and third-party aggregators disagree with each other.
- The agent definition (model, instructions, tools) is passed by the caller when the session is created. There is no versioned, immutable agent resource and no CloudFormation type, so the orchestrator Lambda would become the versioned home of the prompt. That changes how "model fixed on the version" is enforced and needs a deliberate decision.
- Subagents are explicitly unsupported in the preview.
- Preview API with no console; the documentation warns that APIs and IAM action names can change. Factorial's self-modification loop should not depend on that.
- Unanswered by the documentation: whether the orchestrator can run `InvokeAgentRuntimeCommand` against the microVM that BMA activated (Prepare and Collect depend on it; the alternative is S3 Files mounts, which synchronise asynchronously), how long a turn may run against the lifecycle server's 300-second turn lease, and whether token usage is reported per turn, which principle 8 requires.

**Gates before a spike:** availability in `eu-west-1`, or a decision to accept a US region for the builder; a published price for the model; and an API stable enough to pin. A throwaway spike in `us-east-1`, outside Factorial's stacks, would answer the command-API and turn-length questions in a day.

## Claude Agent SDK on AgentCore Runtime

Evaluated on 2026-10-22 as a fifth option. The Claude Agent SDK is Claude Code as a library (`@anthropic-ai/claude-agent-sdk`): `query(prompt, options)` spawns the bundled `claude` binary as a subprocess that owns the shell, the working directory and the transcript. It ships the built-in tools, automatic compaction as the context nears the window, subagents with isolated context and per-agent tools and model, hooks that run in the host process, permission rules, `maxTurns` and `maxBudgetUsd`, and a result message carrying cost and usage. There is no official AWS guide for it on AgentCore Runtime, but Runtime is a plain ARM64 container behind an HTTP contract, and the SDK's hosting guide covers that shape (one subprocess per session, about 1 GiB RAM, state on local disk).

**What it would give Factorial**

- Compaction below the model window and subagents in the builder's own session, sharing its working tree: both gaps in this record, closed by a harness someone else maintains.
- TypeScript, so the one-language convention holds. The loop Factorial owns is the thin layer around `query()` (seeding, streaming the transcript out, limits), not an agent loop.
- Hooks in Factorial's own process, outside the model's reach. A `PreToolUse` hook is a real guard, unlike Harness hooks, which run under the agent's role.
- Cost and usage per run in the result, and `maxBudgetUsd` as a hard per-item cap, which is most of #63.
- Everything else unchanged. A Runtime has the same microVM, session command API, versions and `live` endpoints as a harness's runtime, so Prepare, Collect, the clean-room push, Test and Review keep working as they are.

**The model becomes a choice.** The SDK reads the same provider variables as Claude Code:

| Route | Model | Key in the sandbox? | Status |
|---|---|---|---|
| Claude Platform on AWS (`CLAUDE_CODE_USE_ANTHROPIC_AWS`) | Claude, first-party API parity | No: SigV4 from the execution role, IAM-controlled | GA in all AWS commercial regions; AWS Marketplace billing in consumption units; no Bedrock model-access approval |
| Amazon Bedrock (`CLAUDE_CODE_USE_BEDROCK`) | Claude | No | Needs the Bedrock model access declined for the proof of concept |
| Z.ai's Anthropic-compatible endpoint (`ANTHROPIC_BASE_URL`) | GLM | Yes, unless injected by a proxy outside the sandbox | Documented by Z.ai for GLM 4.7 with Claude Code; GLM 5.3 Flash unverified |

Claude Platform on AWS removes the third-party key the way Bedrock Managed Agents does, and is available in `eu-west-1` now. At first-party list prices Haiku 5.5 costs no more than GLM 5.3 Flash, and Sonnet 5.5 is the tier at which the step-count pattern seen on Flash goes away. The harness is tuned for Claude; a GLM model behind the Anthropic-compatible endpoint would get the loop but not the model it was built around.

**Costs and risks**

- Factorial owns the Runtime container and the layer around the SDK. Smaller than a Strands loop, but code in the security surface and in every pull request Factorial raises against itself.
- The agent definition (prompt, tools, model) lives in that code and is versioned by the Runtime version rather than a harness version. The `live` alias rule holds unchanged; "model fixed on the version" is enforced by the image and by IAM on the execution role, which needs a deliberate decision and a note in `docs/security.md`.
- With a Z.ai key, `ANTHROPIC_AUTH_TOKEN` sits in the subprocess environment, readable from the shell. The SDK's own guidance is a credential-injecting proxy outside the sandbox. Claude Platform on AWS avoids the problem.
- The SDK is licensed under Anthropic's Commercial Terms of Service, not an open-source licence. The dependency convention requires stating that before it is added.
- `bypassPermissions` cannot run as root, and Runtime command sessions run as root. The SDK would run as a non-root user in the container, which `docs/security.md` already lists as a change to make.
- Subagent fan-out needs the depth, concurrency and budget caps set, or one run can grow into a tree of agents.

**Is it a better design than Factorial's?** It is a better agent layer than the Harness for the builder, provided the model is Claude. It is not a replacement for the design: triggers, the state machine, the orchestrator Lambdas, the GitHub App tokens, the clean-room push, the trusted test workflow, the artefact store and the ledger are what make Factorial safe and reconstructable, and none of them depends on which harness runs inside the Build state. What it would simplify is the agent stack: the per-role harness template and its gotchas, the invoker's stream handling, and later the rounds mechanism (compaction replaces it) and the plan hand-over (a plan subagent can write `plan.json` in the same session, still validated and stored by the orchestrator). The reviewer stays a separate session on whichever harness, because judged output must never run in the session that produced it.

**Spike:** the builder only, on a Runtime in `eu-west-1`, with Claude Platform on AWS. Run a #87-sized item on Haiku 5.5 and on Sonnet 5.5 against GLM 5.3 Flash on the Harness, and compare rounds, calls, tokens, cost and outcome. The planner and reviewer stay on Harness for the spike.

## Revisit when

- After items 1 to 4, a six-step plan still needs more than two rounds, or rounds lose work between sessions.
- A role needs delegation inside its own session: a subagent that must see the builder's uncommitted working tree.
- AWS adds a threshold to Harness truncation (removing the gap), or documents subagents for the Harness (removing the second trigger).
- The model moves to one whose vendor SDK brings its own harness, and running that harness on Runtime is cheaper than reproducing it in configuration.
- Bedrock Managed Agents passes its gates above, which would make it the managed alternative to the Agent SDK spike.

If revisited, the order is: the Claude Agent SDK on a Runtime (available now, closes both gaps, TypeScript); then Bedrock Managed Agents if its gates are met (managed, no loop code); then Strands on Runtime as the last resort. Each is kept to the builder, with the planner and reviewer staying on Harness so that the roles that judge the builder's output never run its code.

## Sources

- AgentCore harness vs Runtime: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-vs-runtime.html
- Harness memory and context truncation: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-memory.html
- Harness tools and inline functions: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-tools.html
- Harness lifecycle hooks: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-lifecycle-hooks.html
- Harness models and invoke-time overrides: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-models.html
- AgentCore Runtime: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html
- Step Functions InvokeHarness integration: https://docs.aws.amazon.com/step-functions/latest/dg/connect-bedrockagentcore.html
- AgentCore pricing: https://aws.amazon.com/bedrock/agentcore/pricing/
- Bedrock Managed Agents: https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-managed-agents-openai.html
- Bedrock Managed Agents on AgentCore Runtime: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-bma.html
- Bedrock Managed Agents preview limitations: https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-managed-agents-openai-quotas-limitations.html
- Bedrock Managed Agents security and roles: https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-managed-agents-openai-security.html
- Bedrock Managed Agents sessions and events: https://docs.aws.amazon.com/bedrock/latest/userguide/bedrock-managed-agents-openai-sessions.html
- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- Hosting the Agent SDK: https://code.claude.com/docs/en/agent-sdk/hosting
- Agent SDK subagents: https://code.claude.com/docs/en/agent-sdk/subagents
- Agent SDK agent loop and compaction: https://code.claude.com/docs/en/agent-sdk/agent-loop
- Agent SDK secure deployment: https://code.claude.com/docs/en/agent-sdk/secure-deployment
- Claude Code on Claude Platform on AWS: https://code.claude.com/docs/en/claude-platform-on-aws
- Claude Platform on AWS: https://platform.claude.com/docs/en/build-with-claude/claude-platform-on-aws
- Z.ai Claude Code integration: https://docs.z.ai/scenario-example/develop-tools/claude
