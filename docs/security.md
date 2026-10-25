# Security design

This document describes the security design Factorial would be given if it were built again from scratch, and shows how far the current implementation already follows it. It expands principle 1 (secure by default) and principle 3 (verified, never trusted) in `docs/architecture-principles.md` into a threat model, a set of design rules and the layers that enforce them. `CLAUDE.md` records what is deployed today; where this document and the implementation disagree, the implementation is the thing to fix, and the gaps are listed at the end.

## 1. Threat model

Factorial takes text it does not control, hands it to a model with a shell, and turns the result into changes to real repositories, including its own. Every run therefore executes untrusted code next to credentials that would be valuable to an attacker.

**What must be protected**

| Asset | Why it matters |
|---|---|
| The default branch of every target repository, including Factorial's own | A change that lands there is deployed or shipped. For Factorial itself it changes the development instance that runs the next work item against this repository (see 3.9). |
| The AWS account | Holds Factorial's own infrastructure, the model credentials and the record of every run. |
| The GitHub App private key, and in the proof of concept the third-party model provider key | Either one lets an attacker act as Factorial. In production there is no model key: models are reached through Bedrock by IAM (3.2). |
| The run record (transcripts, plans, bundles, test results) | The evidence a reviewer uses to judge a change and the audit trail after an incident. |

**Where attacks come from**

- **Prompt injection.** Issue text, repository contents, CI logs, web pages and dependency READMEs all reach the model. Any of them can carry instructions ("push to main", "print your environment", "add this workflow step").
- **Model output.** A model can produce wrong or malicious code, commits, scripts and tool calls without any attacker at all.
- **Supply chain inside the session.** The builder installs packages and runs their build scripts. Those scripts run with whatever the session can reach.
- **Factorial's own code.** An orchestrator bug can leak a token or push the wrong commit; the orchestrator builds shell scripts from values that arrived in webhooks.
- **A compromised pull request to Factorial.** Factorial builds itself, so a bad change to its own templates, prompts or workflows changes every later run of the development instance. It reaches other repositories only if it is then cut into a release and approved for promotion (3.9).

**What is assumed to hold.** AgentCore's session isolation (one microVM per session), IAM, GitHub's organisation rulesets and OIDC, and the integrity of the AWS and GitHub control planes. Factorial's repository and every target repository live in one GitHub organisation whose rulesets protect the default branch and release tags, and repository admins cannot bypass or edit them. The design does not try to defend against a failure of those.

## 2. Design rules

Nine rules follow from the threat model. Each is enforced by infrastructure, not by instruction to the model.

1. **A model session is untrusted from the first token.** The session is set up by deterministic code, the model runs, and from then on everything in that session (files, git state, shell environment, installed tools) is treated as attacker-controlled. Output leaves as data and is checked before anything acts on it.
2. **No credential ever enters the sandbox.** Tokens are minted outside, used for one command as a header, and never written to the session. In production the agent's role reaches models through Bedrock by IAM and holds no key at all. In the proof of concept, where a third-party provider is used, the only key the role can resolve is that model key, and only through the service, never from the shell.
3. **Capability is granted by infrastructure, never by prompt.** What a role may do is fixed by IAM, a permissions boundary, the harness's tool allow-list and the harness version. The prompt explains the job; it is not a control.
4. **Every trust transition is an artefact.** Where work moves from one role to another, or from an agent to the orchestrator, it moves as a file the orchestrator reads, validates and stores. There is no shared mutable state between stages.
5. **Verification runs on trusted definitions.** Tests run from the workflow on the default branch, on a checkout of the work commit held as data, with no credentials. The pull request head is the commit that passed.
6. **One trust boundary, one session.** Each trust boundary is its own harness or Runtime, session and IAM role, with the smallest tool set that does its job. Subagents share their parent's trust level and never cross a boundary. A boundary is crossed whenever the next session could have been written to by a model.
7. **Humans gate every irreversible step.** Nothing merges, deploys or promotes without a human approval that the system cannot grant itself.
8. **The control plane is least-privilege too.** The deploy role, the CloudFormation execution role and the boundaries are scoped to Factorial's own names, so even a compromised deployment cannot reach outside them.
9. **Nothing is deleted and everything is attributable.** The record of a run is write-once, redacted, and joined by one correlation key from trigger to pull request.

## 3. The layers

Each layer is independent: it stops a class of attack on its own, and it does not rely on the layers inside it holding. Together they are the defence in depth.

### 3.1 Account and deployment control plane

- The foundation stack is deployed once by a human. It creates the GitHub OIDC provider, the deploy role, the CloudFormation execution role and both permissions boundaries, and nothing else can change them.
- The deploy role trusts only GitHub Actions jobs from this repository, on `main`, in the `production` environment. A job without that environment presents a different OIDC subject and is refused. The repository and owner are identified by immutable id, not by name.
- The CloudFormation execution role can only create resources named `factorial-*`, and refuses to create or modify any IAM role that does not carry one of the two boundaries. A template cannot create an unbounded role by mistake.
- Only the deploy role may move a `live` alias. Every version is immutable, so promotion and rollback are both a pointer move, and in-flight work finishes on the version it started with. This is the promotion inside one instance; promotion between the development instance and a release is a separate, human-approved step (3.9).

### 3.2 Identity and credentials

- Factorial is a GitHub App, not a user token. Installation tokens are minted by orchestrator Lambdas for one repository and only the permissions the step needs, and expire within the hour:

  | Step | Token permissions |
  |---|---|
  | Prepare, ContinueBuild, PrepareReview (clone) | `contents: read` |
  | Prepare (fetch failing-check logs for rework) | `contents: read`, `actions: read` |
  | Collect (clean-room push) | `contents: write`, plus `workflows: write` only when the change edits a workflow |
  | OpenPullRequest | `contents: read`, `pull_requests: write`, `issues: write` |
  | Report | `issues: write` |

- A token is sent as an HTTP header on the single git command that needs it and is never written to disk or to the session's environment.
- **Model access in production is IAM, not a key.** The target is Bedrock: the agent execution role is allowed `bedrock:InvokeModel` on the approved model or inference profile ARNs and nothing more, so there is no model credential to hold, rotate, leak or vault. The agent boundary already carries the Bedrock statement; scoping its resource from `*` to the approved models is part of making the switch.
- **The third-party key is a proof-of-concept artefact.** The proof of concept uses a third-party provider (Z.ai) because the chosen model is not on Bedrock, so a provider key exists. It lives in AgentCore Identity's token vault, and the agent's role may resolve it only with the `aws:ViaAWSService` condition: the managed harness loop can fetch the key to call the model, but a shell command in the same session cannot read the secret. When the model moves to Bedrock, the credential provider, the vault entry and the `ModelCredentials` and `SecretsViaServiceOnly` statements in the agent boundary are removed.
- The GitHub App private key, and the provider key while it exists, are created by a human and referenced by name. They never pass through templates, parameters, the repository or logs.

### 3.3 The agent sandbox

- Each session is its own microVM, discarded when the run ends.
- The image is built from a base pinned by digest, holds no credentials and no credential helpers, and is tagged by the tree hash of its source so the running image is traceable to a commit.
- The agent execution role is held under `factorial-agent-permissions-boundary`, which allows model invocation, service-mediated credential resolution, web search through Factorial's own gateway, image pull and logging, and nothing else. The agent cannot reach the artefact store, the ledger, GitHub, Step Functions, CloudFormation or any other account resource, whatever its prompt says.
- The model, the tool allow-list, the iteration cap, the loop timeout and the output cap are fixed on the harness version. The invoker passes none of them at invoke time, so a run cannot be given more capability than its version declares.
- Every git command the orchestrator runs in a session uses a hardened environment: no system or global git config, no terminal prompt, no askpass helper. Nothing the agent writes to a config file can inject into those commands.
- Values that reach a session script from outside (owner, repository, branch, commit) are validated against strict patterns and shell-quoted before use, because they originate in a webhook payload.
- The builder's `WebFetch` tool, which its plan subagent also has, runs inside the Claude Code subprocess as the `agent` user, with the same network reach its shell's `curl` already has, so it adds no egress the session lacked. Its extraction call goes through the configured Bedrock provider on the background model, which the execution role already allows. Fetched pages are untrusted data, like search results. Before each fetch, Claude Code sends the requested hostname (not the URL, path or content) to `api.anthropic.com` to check it against a blocklist; per Anthropic's data-usage page this check runs whatever the model provider and is **not** covered by `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, which `environment.ts` sets. If the session cannot reach `api.anthropic.com`, WebFetch fails until it can or `skipWebFetchPreflight` is set; skipping the check is a follow-up decision, not made here. Source: https://docs.anthropic.com/en/docs/claude-code/data-usage

### 3.4 Stage isolation and the clean room

This is the layer that makes the hostile-session rule real.

- **One session per trust boundary.** The builder and the reviewer are separate, with separate runtimes, sessions and IAM roles, and never share a filesystem. Since phase 3.1 of `docs/agent-sdk-plan.md` (2026-10-25) the planner is the builder's `plan` subagent (Read, Grep, Glob, web search and WebFetch, and Write limited by the host's `PreToolUse` hook to `plan.json` and `plan.md`), inside the builder's trust boundary (rule 6, section 9): the plan is the builder's own claim, like its summary. Collect reads `plan.md` and `plan.json` out of the session as the `agent` user, validates the JSON against the plan contract and stores both; a build without a valid plan pushes nothing and ends as `invalid-plan`. The reviewer and a later round receive the stored, validated copy. Until then (tag `stage-0-harness`) the planner was a separate harness whose validated plan was written into a fresh builder session.
- **The builder's output leaves as a bundle.** After the build, the orchestrator exports the new commits as a git bundle and stores the session's files. It does not push from the builder's session.
- **The push happens in a clean room.** A separate session, which no model has run in, clones the repository afresh with hooks disabled, imports the bundle and checks that the imported head is exactly the commit the orchestrator expected, that the base commit is its ancestor, and that there are no merge commits. It then re-creates every commit with the App's bot identity, which discards whatever author, committer, signature or extra object the agent produced, and pushes a fast-forward to a `factorial/*` branch. A new branch must not already exist; a rework branch must still be at the head the session started from. No force push is ever issued.
- **Why the split matters.** A single container running every stage, with sub-agents sharing a filesystem, would let anything the builder planted (a git hook, a modified tool on `PATH`, a shell profile, a doctored test fixture) act on the stages after it, including a reviewer whose verdict the orchestrator trusts. Separate sessions make each role's input a stored artefact a human can read, and keep each role's tools and model enforceable by the harness version rather than by code running inside the sandbox. Roles may share a session only when neither of them can write: a read-only explorer and a planner, for example, but never the builder and anything that judges or ships its output.

### 3.5 Verification on trusted definitions

- Tests are run by dispatching `test.yml` on the default branch, so the workflow definition is always the one a human merged, never the one in the change under test.
- The job that runs the checks has `contents: read` only, checks out the work commit as data with `persist-credentials: false`, uses no Actions cache and sees no secrets. A separate job, which never touches the work commit, assumes the callback role through OIDC and reports the result to Step Functions. The task token in the inputs is useless without that role.
- The pull request step verifies that the branch head is the commit that was tested before it opens the PR. What was tested is what is proposed.
- Completion is signalled by infrastructure: the Fargate invoker task running to completion, and the Step Functions task token from the report job. The agent's own report that something worked is stored, but nothing acts on it.

### 3.6 Repository protection

- The default branch of every repository in the organisation, Factorial's own included, is protected by an organisation ruleset: changes land only through a pull request with an approving review from a code owner, the repository's required checks must pass, and force pushes and deletions are blocked. The ruleset is set at organisation level, so a repository admin cannot bypass, weaken or remove it, and a target repository is protected from the day it is created with no per-repository step to forget. The App is not a bypass actor, so even its `contents: write` token cannot reach a default branch.
- A second organisation ruleset confines the App to its own namespace: on every branch other than `factorial/**`, creations and updates are restricted to people, so the orchestrator's rule of pushing only to `factorial/*` branches is enforced by GitHub rather than by code.
- Release tags are protected by an organisation ruleset against moves and deletion, which is what the release tier in 3.9 relies on.
- Every pull request against Factorial's own repository is approved by a human. There is no privileged path for Factorial's changes to itself.
- The orchestrator pushes only to `factorial/*` branches, and the ruleset above is what makes that a guarantee rather than a convention.

### 3.7 The record

- Every stage writes its inputs and outputs to the artefact store under `<workItemId>/<attempt>/<stage>/`. The bucket is versioned, requires TLS, and its policy denies `DeleteObject` and `DeleteObjectVersion` to every principal. Retention is a lifecycle rule, never a permission someone could use.
- Only orchestrator Lambdas and the invoker hold the write policy, which grants `PutObject` and nothing else. No agent role can reach the bucket.
- Text is redacted before upload and before logging. The ledger holds status, usage and pointers, never content.
- One correlation key, the work item id, is the execution name, the session id, the artefact prefix, the ledger key and an attribute on every log line, so any run can be reconstructed afterwards from one value.

### 3.8 Untrusted input

- Issue text, repository contents, search results and CI logs are data. The prompts say so, but the layers above are what enforce it: an injected instruction can make the model try something, and the sandbox, the token scoping and the clean room are what make the attempt fail.
- Logs from failed checks are fetched outside the sandbox with a short-lived `actions: read` token, truncated to the last 200 lines and redacted before they are written into the rework session.
- Model output is never executed by the orchestrator. The orchestrator reads files with fixed names and size caps, validates structured output against a schema, and acts only on fields the schema defines.

### 3.9 Self-building and releases

Factorial builds itself only to speed up its own development. Self-built versions serve one purpose: running the next work item against this repository.

- **Two tiers.** The development instance deploys every merge to `main` and uses the newest version for its next work item against Factorial's own repository. Any other repository is served by a tagged release of Factorial, deployed separately, that has passed verification and an explicit human approval to promote. A self-built version never reaches another repository on its own.
- **What this bounds.** A bad change that passes review still only changes how Factorial works on Factorial. The blast radius of self-modification is the development instance and this repository, both of which are reversible by moving `live` back or reverting the merge.
- **What the release path must carry.** The release is the trust transition from development to production use, so it needs the same care as any other: releases are cut from `main` by the deploy role, identified by an immutable reference (a tag protected by the organisation ruleset in 3.6 against moves and deletion, pinned by commit), verified on trusted definitions, and promoted only by a human approval that the system cannot grant itself. Which account or stack runs the release, and how its `live` aliases are moved, is decided when the release path is built; the principle is fixed now.

## 4. How the layers combine

The point of defence in depth is that each likely failure is stopped more than once.

| Scenario | Stopped by |
|---|---|
| An issue says "push this straight to main" and the model tries | No token in the session (3.2). The push happens only from the clean room, only to `factorial/*` (3.4). The organisation ruleset refuses the App on every default branch regardless (3.6). |
| The builder installs a package whose postinstall script reads the environment | Nothing in the environment is worth reading (3.2, 3.3). The session's IAM role cannot reach any account resource (3.3). |
| The builder plants a git hook or edits a tool so the push or the tests do something else | Hooks are disabled and the clone is fresh in the clean room; commits are re-created from trees and messages only (3.4). Tests run from the definition on `main`, in a job with no credentials (3.5). |
| The change edits the test workflow to exfiltrate secrets | The dispatched workflow is `main`'s, not the change's (3.5). The only secrets are role ARNs, and both OIDC trusts are bound to `main`. |
| The model tries to deploy Factorial or move a `live` alias | The agent boundary has no such permission (3.3). The CloudFormation role refuses unbounded roles and foreign names (3.1). Only the deploy role may promote (3.1). |
| An orchestrator Lambda is compromised or buggy | Its role sits under the runtime boundary; its tokens are per step and per repository; its artefact access is write-only (3.2, 3.7). Its pushes still go through the ruleset (3.6). |
| A bad change to Factorial is merged | A human approved it (3.6). The previous version is immutable and `live` can be moved back (3.1). It affects only the development instance until a human cuts and approves a release (3.9). |
| Someone tries to alter or remove the record of a run | Deletes are denied to every principal and the bucket is versioned (3.7). |

## 5. Recommended practice this follows

- **AWS Well-Architected, Security Pillar:** strong identity foundation (OIDC federation, no long-lived keys), least privilege with permissions boundaries, traceability (one correlation key, immutable record), and security at all layers.
- **NIST SP 800-207, zero trust:** every session is a new trust decision, access is per request and per resource, and nothing is trusted because of where it runs.
- **OWASP Top 10 for LLM Applications:** prompt injection and excessive agency are addressed by capability limits outside the model; insecure output handling by validating structured output and never executing model text; supply chain by running installs inside a sandbox with nothing to steal.
- **GitHub's guidance on untrusted code in Actions:** never run code from a pull request with secrets or write tokens, split the privileged step into a separate job, pin actions by commit, disable credential persistence.
- **Container hardening (CIS Docker Benchmark):** base images pinned by digest, no credentials in images, minimal toolchain, immutable tags derived from source.

## 6. From scratch: what to lay down on day one

If Factorial were rebuilt, these would be in the first version, in this order, because each is far cheaper to have from the start than to retrofit:

1. The two permissions boundaries and the name-scoped CloudFormation role, before any other stack exists.
2. OIDC-only deployment bound to `main` and a deployment environment; no access keys anywhere.
3. A GitHub App with per-step, per-repository tokens, inside an organisation whose rulesets protect every default branch and release tag, confine the App to `factorial/**`, and admit no bypass for the App or for repository admins.
4. The clean-room push and the bundle hand-over, so no agent session ever holds a write token.
5. Tests dispatched from the trusted branch with the work commit as data.
6. One harness per role with the model and tools fixed on the version, so the first prompt written never has to be split later.
7. The write-once, redacted artefact store and the correlation key, so every run from the first one is reconstructable.
8. An egress allow-list on the session network, and a recorded decision on the container user (section 8.5).

## 7. Where today's implementation falls short

These are the gaps between this design and what is deployed. Each is a candidate work item, except where a decision to accept the divergence is recorded.

- **Sessions run as root, by decision.** The image sets no `USER`, so the model's shell runs as root inside the microVM. This is an accepted divergence, not a work item: section 8 explains how the user is applied, what changing it would involve, and why it was decided against for now.
- **Session egress is unrestricted, for the proof of concept only.** Both harnesses use `NetworkMode: PUBLIC`. This is a deliberate shortcut: VPC mode needs private subnets with a NAT gateway for outbound access, which was not worth setting up for the proof of concept. VPC mode is the target. In a real environment the harnesses run in private subnets behind a NAT gateway, with security groups and an egress allow-list (GitHub, the model endpoint, package registries) limiting what injected instructions can reach. The session holds nothing to exfiltrate today, but this is the first of the gaps to close.
- **A third-party model key exists, for the proof of concept only.** The model is reached through Z.ai with a provider key in the token vault, and the agent boundary allows `bedrock:InvokeModel` on every model. Production uses Bedrock by IAM, with no key and the Bedrock statement scoped to the approved model ARNs; the credential provider and the vault entry go when the model moves.
- **The planner's read-only role is enforced by prompt.** The planner has the same built-in shell and file tools as the builder and is told not to write. The design calls for the harness version to withhold write tools from read-only roles once the harness supports that distinction.
- **A change that edits `.github/workflows/` is pushed with `workflows: write`**, and CI then runs the edited workflow on the pull request with the repository's secrets available. The secrets are role ARNs only and both OIDC trusts are bound to `main`, which limits the exposure; keep it that way and review workflow changes with care.
- **The organisation rulesets are not yet in place.** The repository is under a personal account with a single repository ruleset on `main` that the admin role can bypass, and no ruleset confines the App to `factorial/**` or protects tags. Moving the repository into the organisation and applying the rulesets in 3.6 closes this; until then the App's `contents: write` token could push to any branch other than `main`, and the `factorial/*` restriction is enforced by the orchestrator alone.
- **Traces are not yet exported**, so the correlation key does not yet reach AgentCore traces.
- **In-session enforcement moves to Factorial-owned code on the Runtime, by decision.** Once a role runs on the Claude Agent SDK, its tool allow-list, hooks, subagents and limits are enforced by Factorial's host process inside the microVM rather than by the managed harness. This is an accepted risk, not a work item: section 9 records the decision and its mitigations.

## 8. Root in the session (accepted decision)

### 8.1 How the user is applied

AgentCore Harness does not require root, but it only half supports anything else.

- A `USER` directive in the Dockerfile applies to the agent process only: the managed loop and the model's shell and file tools run as that user.
- Commands sent through `InvokeAgentRuntimeCommand` always run as root (uid 0) in the microVM. This is not configurable. AWS's stated position is that the IAM permission to send a command is the access gate, and the in-VM privilege level is not a boundary, in the same way that `docker exec` defaults to root even when the container runs as a non-root user.
- The harness overrides the image's `ENTRYPOINT` and `CMD`, so the user cannot be dropped by a startup script; it has to come from `USER`.

For Factorial this means every orchestrator command (clone, seed files, bundle, read logs, the clean-room push) runs as root whatever the image says, and only the planner's and builder's own tool calls would run as the user. That is still the part worth constraining, because it is the part a prompt injection drives.

Today the image sets no `USER`, so the model's shell runs as root. The Dockerfile records the reason: the orchestrator's pre-invocation commands run as root, so a non-root agent user would own nothing they create.

### 8.2 What a non-root user buys

A root shell lets a prompt-injected builder replace `git`, `node`, `quiet` or `base64` under `/usr`, edit `/etc`, or change the system git config. Collect's root commands in the same session then run the replaced tools. The clean room means a forged bundle cannot push anything the model could not have committed anyway, so this is not an open hole. What a non-root user closes is the model's ability to tamper with the environment the orchestrator's later commands rely on, and with the tools that produce the stored logs and summary. It also removes `apt-get` and writes under `/opt/factorial`, which nothing legitimate needs: the builder's prompt already forbids global installs and the planner is told to install nothing.

### 8.3 What breaks if only `USER` is added

Every run fails at the first edit:

- Prepare and CollectPlan run as root, so `/workspace/repo`, `notes.md`, `workitem.json` and the plan files are root-owned. The agent cannot write to them, commit, or create `/workspace/logs` for `quiet`.
- Git refuses to operate in a repository owned by another user ("dubious ownership"), so even the agent's reads fail, and once the agent owns the files, Collect's root-run `git status`, `rev-parse` and `bundle create` fail the other way round.

### 8.4 How to implement it

All of the changes are small and in code that is already under test.

1. **Dockerfile.** The Node base image ships a `node` user (uid 1000) with a home directory. Give it `/workspace` (`chown node:node /workspace`), set `HOME=/home/node`, and add `USER node` as the last instruction. Replace the comment that explains the root decision.
2. **Prepare and CollectPlan.** Run the clone and checkout as the user, through `runuser -u node --` (or `setpriv`), so everything under `/workspace` is created with the right owner. The token remains a command-line header either way. The alternative, finishing the setup script with `chown -R node:node /workspace`, also works but leaves the clone itself running as root.
3. **Collect and SaveWork.** The session-side commands (the leftover commit, `rev-list`, `rev-parse`, `diff`, `bundle create`) run as the user through `runuser` as well. This is preferable to keeping root and passing `-c safe.directory=/workspace/repo` (which git honours, because the command line is a protected configuration scope), because it stops root running git inside a repository the model controls. Reading the session's files for the artefact store needs no change: root reads anything.
4. **The clean room.** Untouched. It is root throughout, and no model runs in it.
5. **Tests and documentation.** The script-text assertions in the orchestration tests, the Dockerfile comment, and the **Agent environment** convention in `CLAUDE.md`.

One thing must be confirmed by direct invocation before the change ships: that the managed harness loop runs correctly as a non-root user. The documentation says `USER` applies to it, but does not list any paths it needs to write.

### 8.5 Decision: accept root for now

**Decided 2026-10-20.** Sessions keep running as root. The change above is sound and remains documented here so it can be made later, but it is not scheduled. The reasons:

- **The boundary is where AWS puts it.** The microVM and the IAM execution role are the isolation. AWS's own guidance is that in-VM privilege is not the access gate, and the clean room already treats everything that leaves a session as untrusted. What a non-root user would protect is the integrity of the stored logs and summary, which this design already treats as the model's claim rather than evidence.
- **The managed loop is not pinned to the image.** AgentCore mounts its loop into the container at session start. If a future loop version, or a feature such as skills or memory, needs to write to a path a non-root user cannot, the break appears between Factorial's deploys, not at one, and there is no version to pin. Root is the default environment, the path every AWS example uses, and the one AWS tests. Non-root is supported but less travelled.
- **It removes `apt-get` from the builder.** Factorial's own repository never needs it, but the end goal is maintaining other software. A target repository that needs `make`, `python3` or a system library would then need its own image or a pre-installed toolchain, a functional cost for a marginal gain.
- **Other gaps are worth more.** An egress allow-list limits what injected instructions can reach at all, and withholding write tools from the planner at the harness level replaces a prompt-enforced restriction with an enforced one. Both rank above this change.

**Revisit when** any of the following happens: a target repository's build output or logs become an input to a trusted decision; AWS documents a non-root user as the recommended default for harnesses; or the harness gains a way to pin the managed loop so the change can be validated against a fixed version.

## 9. In-session enforcement in Factorial-owned code (accepted decision)

**Decided 2026-10-23**, as part of the move to the Claude Agent SDK on AgentCore Runtime (`docs/agent-sdk-plan.md`). It takes effect for a role when that role first runs on a Runtime; until then the harness enforces as described in section 3.

### 9.1 What changes

On the Harness, the tool allow-list, the model and the loop's limits are enforced by a managed process in the microVM that Factorial does not own. On the Runtime they are enforced by Factorial's TypeScript host process around the SDK's `query()`: permission rules, hooks, subagent definitions and caps. Section 3.4 names "code running inside the sandbox" as the thing to avoid; this decision accepts it for in-session controls only. No outer boundary changes: the execution role, the permissions boundaries, the hostile-session rule, the bundle and clean room, the trusted test workflow and the tested-head check are untouched, and none of them depends on which loop ran in Build.

### 9.2 Mitigations

- **Non-root agent user.** The SDK subprocess, and therefore the model's shell and file tools, runs as a non-root user (`bypassPermissions` refuses root in any case). This supersedes the root decision in section 8 for Runtime images; section 8 continues to apply to the Harness while it remains.
- **Host process separated from the agent.** The host process runs as root and starts the SDK's subprocess as the agent user through a `setpriv` wrapper, with no-new-privileges and an empty capability bounding set. The model therefore cannot signal or trace the process that holds the hooks and limits, read its environment, or edit the run's record, which the host keeps in `/var/lib/factorial` (root-only). The host's own `HOME` and working directory are root-owned, so as root it never reads configuration the agent user can write (an `~/.aws/config` with a `credential_process` would otherwise run as root); it refuses to start if either is under `/workspace` or the agent's home.
- **Root never works in the model's tree.** The orchestrator's session commands run as root. They seed the workspace in a fresh session and then hand it to the agent user (`chown -R`), before any model has run. After the run, every command that runs git or reads files in `/workspace` (Collect's inspection, its leftover commit, the bundle and the session-file export) drops to the agent user through the same `setpriv` restrictions as the host's wrapper. This is section 8.4's step 3, extended to the file reads, so a link or git configuration the model planted acts with no more than the model's own privileges. The clean room is untouched: no model runs in it.
- **Root-owned host files.** The host process, the SDK and the agent definitions are installed root-owned and read-only to the agent user, so the model cannot edit what constrains it.
- **Nothing read from disk.** Agents, hooks and permission rules are passed in code with `settingSources: []`, so nothing under `.claude/` in the workspace or home directory is read.
- **Model fixed twice.** The model is set on the immutable Runtime version's environment and passed by the host code, never taken from the request; the execution role is allowed only that model's Bedrock inference profile.
- **Caps in the host.** Subagent depth, concurrency, per-agent turns, `maxTurns` and `maxBudgetUsd` are set by the host process.
- **No subagent output is evidence.** Subagent reports are the model's claim, like the builder's summary. Anything the orchestrator acts on still leaves as a named file and is validated outside the session.

### 9.3 Why this is acceptable

The in-session allow-list was never the access gate: as section 8 says, it constrains what a prompt injection can drive, and the gates are the outer rules above. On Bedrock the execution role signs with SigV4 and holds no key, which is rule 2's production shape and removes the third-party key gap in section 7. Net, one in-session control moves from AWS-owned to Factorial-owned code, and the credential surface shrinks.

**Revisit when** an in-session decision (a hook verdict, a subagent report) becomes an input to a trusted decision without being re-checked outside the session, or AgentCore offers a managed loop that can host the SDK's subagents and compaction.
