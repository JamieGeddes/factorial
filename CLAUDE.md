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
- Deterministic steps around the agent (clone the repository, run tests, push the branch) run through the session command API, not through the model.

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
- **Agents never deploy or promote Factorial.** Only the GitHub Actions deployment role may deploy Factorial or move a `live` alias.

## Current stage

**Stage 0: not started.** The `WorkItem` contract has not yet been defined.

### Stage 0 scope

| Area | Stage 0 |
|---|---|
| Triggers | GitHub issues only |
| EventBridge | One bus, one rule |
| Step Functions | Three states: build → test → PR |
| Agents | One Harness that both plans and builds, using GLM 5.3 Flash via the Z.ai API (general endpoint) |
| Verification | Automated tests run via GitHub Actions; no sandbox smoke test yet |
| Promotion | Move the `live` aliases after a successful deploy |

### Known gaps in Stage 0

- No smoke test, so the output requirement is not yet fully met.
- No staging canary, so Factorial's changes to itself are checked only by tests and human review.

### Next, in order

1. Sandbox smoke-test stage (ephemeral AWS account).
2. Staging canary before promotion.

Later stages (more triggers, the full stage graph, separate Planner and Builder agents, Memory, rollback) are added as work items once these are in place.

### Keeping this section up to date

When a change completes or alters a stage, update **Current stage** in the same PR.

## Conventions

- **Deployments:** all deployments run through GitHub Actions.
- **Sandbox access:** agents in the inner loop may deploy to the sandbox environment and read its state directly to verify their work.
- **Infrastructure as code:** Factorial's infrastructure is defined in CloudFormation templates written in YAML, using the `.yml` extension.
- **Language:** all code Factorial owns (Lambdas, tooling, container images) is implemented in TypeScript. The agent loop itself is the managed AgentCore Harness, which is configuration, not code.
- **Model credentials:** third-party model API keys are held in AgentCore Identity's token vault and referenced by ARN. They never appear in the repository, templates, parameters or logs.
- **Compute:** serverless resources are favoured over servers. Where a container is unavoidable, use Fargate, never EC2 instances.
- **Security:** security is vital. The system must enforce suitable access controls at every level: IAM least privilege per role, no shared credentials, and agent roles that can never deploy or promote Factorial.
- **Region:** Factorial and all its associated resources are deployed to `eu-west-1`.
