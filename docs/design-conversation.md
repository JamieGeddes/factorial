# Building an AI software factory with AWS AgentCore

Transcript of the claude.ai design conversation for Factorial, retrieved 2026-10-16.
Source: https://claude.ai/chat/20b2edca-9fca-4a78-b033-d1e2e42ace1c

Speaker turns are level-2 headings; headings inside Claude's replies have been demoted one level. Text is otherwise verbatim.

---

## User

I want to create a “software factory”, a system for building and refining software codebases via an agentic AI environment, using AWS AgentCore and associated services as the building blocks. The system needs to support multiple input triggers, such as JIRA tickets, GitHub issues or alerts from production systems. The output is a pull request for human approval, once the code has been implemented on a branch, validated with existing and new automated test cases, and has passed a smoke test in a sandbox deployment environment (e.g. a dedicated ephemeral AWS account). The system needs to be extensible to handle future requirements, such as new trigger types, different types of context providers (such as knowledge graphs) and integrations with external systems. Could this system be built in a way that it bootstraps itself, I.e. builds itself incrementally? Suggest how this could be achieved from an initial starting point and basic set of requirements. The core principle is that the system should be able to update itself, based on new requirements from the system designer, to the point where it could be used to build and maintain other pieces of software, for example performing bulk upgrades of Lambda runtime upgrades across multiple repositories.

## Claude

### Mapping onto AWS

AgentCore is a set of modular services: Runtime, Memory, Gateway, Identity, built-in Code Interpreter and Browser tools, plus Observability, Evaluations, Policy, and Registry. That maps neatly:

- **Triggers:** EventBridge is the spine. Each source (Jira webhook, GitHub App, CloudWatch/Alarm → SNS) is a thin adapter Lambda that emits one canonical `WorkItem` event. New trigger type = new adapter, nothing else changes.
- **Orchestration:** Step Functions runs the stage graph (intake → plan → build → verify → smoke → PR), with retries, timeouts and a human-approval pause. Keep the orchestration deterministic; the agents live inside the states.
- **Agents:** Planner and Builder run on AgentCore Runtime (note: the V2 runtime announced in September 2026 bills for memory actually used and gives consistent cold starts, which suits bursty build work). Memory holds per-repo conventions and past outcomes.
- **Tools and integrations:** everything external goes through Gateway as MCP tools — GitHub, Jira, your test runner, your knowledge graph. Context providers are just read-only MCP servers, so a knowledge graph is a new tool registration, not a new architecture. Identity handles per-tool credentials; Policy sets hard limits (e.g. "can only push to `factory/*` branches").
- **Verification:** CodeBuild runs the test suites in an isolated container (not inside the agent). Smoke tests use an ephemeral account vended from an AWS Organizations pool via Control Tower/Account Factory, deployed with the repo's own IaC, then nuked (`aws-nuke` or `cloud-nuke`).
- **Evidence:** the PR body carries plan, test diff, coverage delta, smoke-test logs and an Observability trace link, so the human reviews outcomes rather than re-reading reasoning.

### Bootstrapping in stages

**Stage 0 (human + a coding agent, ~a week):** Write only what's needed for the loop to close once: one trigger (GitHub issue), Step Functions skeleton, one Builder agent, CodeBuild tests, PR creation. No sandbox, no Jira. Crucially, Stage 0 also includes the factory's own CDK app, its CI, and a `CONVENTIONS.md`/`ARCHITECTURE.md` the Planner will read. Deploy it.

**Stage 1 (first self-build):** Open a GitHub issue on the factory repo: "Add a Jira trigger adapter following the adapter contract." The factory builds it, you review. If it fails, fix by hand, but file the failure as the next issue — the factory should learn to handle that class of failure.

**Stage 2+ (requirements as tickets):** Everything else — ephemeral-account smoke stage, Memory integration, alert triggers, knowledge-graph provider — arrives as tickets. Order them so each one makes the next cheaper: the sandbox stage first (so the factory can smoke-test its own changes), then Evaluations (so regressions in agent behaviour are caught like code regressions).

**Stage N (multi-repo tasks):** The Lambda runtime upgrade becomes a "campaign" trigger: one ticket fans out via EventBridge into one `WorkItem` per repo, each producing its own PR, with a campaign dashboard aggregating results. That's a new trigger adapter plus a fan-out state, both built by the factory.

### What makes it extensible

Three stable contracts, fixed in Stage 0 and treated as the factory's API: the `WorkItem` schema, the MCP tool interface for providers, and the Step Functions state interface (input/output JSON). Extensions plug into those; the core never needs to know about them.

### Trade-offs to decide early

- **Self-modification blast radius:** the factory should deploy its own changes to a staging copy of itself and run a canary ticket before promoting. Don't let it modify Policy or IAM without a second human approval.
- **Orchestration vs. agent autonomy:** a fixed Step Functions graph is less flexible than a free-roaming agent, but it's debuggable and bounds cost. Start fixed; let agents propose new stages via tickets.
- **Cost:** ephemeral accounts and full test suites per ticket add up. Budget guardrails per `WorkItem`, and let the Planner skip the sandbox when a change is docs-only.

I can turn this into a doc with the Stage 0 ticket backlog and the three contract schemas if that would help.

## User

Some conventions: GitHub actions are used for all deployments. Agents in the inner loop may deploy to the sandbox environment and read the state directly to verify. CloudFormation JSON templates will be used for IAC of the software factory.

The factory will be named Factorial

## Claude

Good news on the IaC choice: AgentCore has native CloudFormation coverage — Runtime, RuntimeEndpoint, Gateway, GatewayTarget, Memory, Policy, PolicyEngine, WorkloadIdentity, credential providers and more, so Factorial can be 100% CloudFormation JSON with no custom resources for the agent layer. Here's how the three conventions reshape the design.

### GitHub Actions for all deployments

This simplifies the diagram: CodeBuild disappears, and the Verify, Sandbox and "deploy Factorial" steps all become Actions workflows.

- **Factorial deploys itself** via a `deploy.yml` on merge to `main`: `cfn-lint` → `cfn-guard` → change set → execute. GitHub OIDC assumes a `FactorialDeployRole`; no stored keys. The same workflow run against a `staging` stack is the canary before production.
- **Step Functions no longer deploys anything.** It dispatches workflows (`workflow_dispatch` via the Gateway GitHub tool) and waits on a callback: the workflow's last step posts its run ID and result to an SQS queue / `SendTaskSuccess` with the task token. Tests and smoke deploys are therefore observable in GitHub's UI, and the PR's check runs are the evidence.
- **Target repos need a contract:** a `factorial/sandbox.yml` workflow that accepts `target_account` and `branch` inputs and deploys the repo's stack there. Repos that lack it get it added by Factorial as their first ticket — that's the onboarding path.

### Agents deploy to the sandbox and read state directly

Reconciling this with "all deployments via Actions": in the inner loop the Builder *triggers* `sandbox.yml` against its branch rather than running `aws cloudformation deploy` itself, then verifies by reading the account directly. That keeps one deployment path while giving the agent the fast feedback loop.

- The Builder gets a `FactorialSandboxReadRole` in the ephemeral account (`cloudformation:Describe*`, `logs:FilterLogEvents`, `lambda:Invoke*` on tagged resources, read-only on the rest), assumed through AgentCore Identity / WorkloadIdentity. Deploy permissions stay with the Actions OIDC role only — a clean separation the Policy engine can enforce.
- The smoke stage then has two parts: the agent's own checks (invoke the function, read stack outputs, grep logs), followed by a deterministic gate — a `smoke.json` assertions file in the target repo that Step Functions evaluates independently. The agent can't mark its own homework.
- Account vending: a small pool of pre-baked accounts in a `Sandbox` OU, leased per `WorkItem` via a DynamoDB lock, nuked and returned on completion. Pre-baking matters because Account Factory creation is minutes, not seconds.

### CloudFormation JSON for Factorial

JSON is verbose but agent-friendly: deterministic, diffable, linted, and the change-set output in each PR is reviewable evidence. Suggested layout:

```
factorial/
  templates/
    00-foundation.json   # OIDC provider, deploy roles, KMS, buckets
    10-triggers.json     # EventBridge bus, adapter Lambdas, schema registry
    20-orchestration.json# Step Functions, SQS callback queue, DynamoDB leases
    30-agents.json       # AgentCore Runtime, Memory, Gateway, GatewayTargets, Policy
    40-sandbox-pool.json # account lease table, nuke runner
  params/{staging,prod}.json
  .github/workflows/{ci,deploy,canary}.yml
  CONVENTIONS.md        # read by the Planner on every factory ticket
```

Two practices that pay off immediately: the `WorkItem` schema lives in EventBridge Schema Registry (so adapters are validated at the edge), and every template's `Outputs` are exported with a `Factorial-` prefix so later stacks reference them by `Fn::ImportValue` rather than hard-coded ARNs — which is exactly what the Builder will need when it adds stack 50.

Stage 0 is now: foundation + triggers + orchestration + agents templates, `ci.yml`/`deploy.yml`, one GitHub-issue adapter, one Builder. The first self-build ticket becomes "add `40-sandbox-pool.json` and the sandbox stage to the state machine."

## User

Correction: yml files will be used for all CloudFormation templates

## Claude

Noted — YAML throughout. That's actually the better choice for Factorial: short-form intrinsics (`!Ref`, `!Sub`, `!GetAtt`), comments, and far less noise in the diffs the Planner and reviewers read.

Updated layout:

```
factorial/
  templates/
    00-foundation.yml
    10-triggers.yml
    20-orchestration.yml
    30-agents.yml
    40-sandbox-pool.yml
  params/{staging,prod}.yml
  .github/workflows/{ci,deploy,canary}.yml
  CONVENTIONS.md
```

Three things worth pinning in `CONVENTIONS.md` so the Builder stays consistent when it edits templates:

- **Style rules:** short-form intrinsics only, `!Sub` over `!Join`, Step Functions definitions as inline `DefinitionString: !Sub |` blocks rather than external JSON, comments explaining *why* above any non-obvious resource. `cfn-lint` with a pinned config in `ci.yml` enforces the rest.
- **Params in YAML, converted at deploy time:** `aws cloudformation deploy --parameter-overrides` wants key=value, so `deploy.yml` does a one-line `yq` conversion. Keeps the source consistent with everything else.
- **Everything is `.yml`, not `.yaml`:** trivial, but a globbing mismatch is exactly the kind of thing that sends an agent down a rabbit hole. Pick one spelling and lint for it.

Everything else from the previous design stands unchanged.

## User

All Factorial PRs for itself will still be human approved. Each time a new version is successfully deployed, the new version should then become the one used for the next action, thereby allowing the system to effectively bootstrap itself

## Claude

That's the right call, and it turns "bootstrap" into a concrete mechanism: a **promotion step at the end of `deploy.yml`** that flips an "active version" pointer, so the next `WorkItem` picked up is handled by the code that was just merged.

### How the pointer works

Factorial has three independently versioned pieces, and all three support aliases natively, so no custom pointer is needed:

- **Agents:** each `AWS::BedrockAgentCore::Runtime` update creates a new immutable version; a `RuntimeEndpoint` named `live` points at one. Promotion = update `live` to the new version.
- **State machine:** Step Functions versions + a `live` alias. In-flight executions keep running on the version they started with; new executions start on the alias target. That's exactly the isolation you want.
- **Adapters/callbacks:** Lambda versions + `live` alias, same pattern. EventBridge rules target the alias.

Step Functions invokes agents by alias ARN, adapters start executions by alias ARN. Nothing in the running system references a version number directly.

### The deploy sequence

`deploy.yml` on merge to `main`:

1. Lint, change set, execute against the **staging** stack set (its own `staging` aliases).
2. **Canary:** dispatch a fixed `WorkItem` (e.g. "bump a comment in `factorial-canary` repo") at staging and wait for a PR to appear with green checks. This proves the new version can complete the loop end to end before it's trusted with real work.
3. Execute against production. New versions exist but aren't live yet.
4. **Promote:** move the three `live` aliases in one step (a small Lambda that does it transactionally, or three sequential CLI calls with rollback on failure).
5. Record `{commit, versions, promoted_at}` in a `FactorialVersions` DynamoDB table and tag the commit `v<n>`. Every `WorkItem` stamps the version that handled it, so PRs say "built by Factorial v47".

Rollback is the same step run with the previous row from the table, so it's a one-click Actions job rather than a redeploy.

### Keeping the loop honest

- **Pointer flips are the one action no agent may perform.** The promote Lambda is callable only by the Actions OIDC role; AgentCore Policy denies `UpdateRuntimeEndpoint`, `UpdateStateMachineAlias` and `UpdateAlias` to all agent roles. Human approval on the PR plus a mechanical promotion is the whole control surface.
- **Let the factory ask for a drain if the schema changes.** When a change alters the `WorkItem` schema or Step Functions I/O contract, the PR should carry a `requires-drain` label, and `deploy.yml` waits for in-flight executions to finish before promoting. The Planner can learn to add the label itself; the human checks it.
- **Memory is shared across versions, not versioned.** That's usually what you want (v48 should benefit from what v47 learned), but a memory-schema change should be handled as a migration with its own ticket, not a code change.

The net effect: a ticket like "teach Factorial to handle Jira triggers" goes in, v47 builds it, you approve, v48 goes live, and the first real Jira ticket is handled by v48 — with nothing in between that a human didn't sign off on.
