# Security design

This document describes the security design Factorial would be given if it were built again from scratch, and shows how far the current implementation already follows it. It expands principle 1 (secure by default) and principle 3 (verified, never trusted) in `docs/architecture-principles.md` into a threat model, a set of design rules and the layers that enforce them. `CLAUDE.md` records what is deployed today; where this document and the implementation disagree, the implementation is the thing to fix, and the gaps are listed at the end.

## 1. Threat model

Factorial takes text it does not control, hands it to a model with a shell, and turns the result into changes to real repositories, including its own. Every run therefore executes untrusted code next to credentials that would be valuable to an attacker.

**What must be protected**

| Asset | Why it matters |
|---|---|
| The default branch of every target repository, including Factorial's own | A change that lands there is deployed or shipped. For Factorial itself it changes the system that runs the next work item. |
| The AWS account | Holds Factorial's own infrastructure, the model credentials and the record of every run. |
| The GitHub App private key and the model provider keys | Either one lets an attacker act as Factorial. |
| The run record (transcripts, plans, bundles, test results) | The evidence a reviewer uses to judge a change and the audit trail after an incident. |

**Where attacks come from**

- **Prompt injection.** Issue text, repository contents, CI logs, web pages and dependency READMEs all reach the model. Any of them can carry instructions ("push to main", "print your environment", "add this workflow step").
- **Model output.** A model can produce wrong or malicious code, commits, scripts and tool calls without any attacker at all.
- **Supply chain inside the session.** The builder installs packages and runs their build scripts. Those scripts run with whatever the session can reach.
- **Factorial's own code.** An orchestrator bug can leak a token or push the wrong commit; the orchestrator builds shell scripts from values that arrived in webhooks.
- **A compromised pull request to Factorial.** Factorial builds itself, so a bad change to its own templates, prompts or workflows changes every later run.

**What is assumed to hold.** AgentCore's session isolation (one microVM per session), IAM, GitHub's repository rulesets and OIDC, and the integrity of the AWS and GitHub control planes. The design does not try to defend against a failure of those.

## 2. Design rules

Nine rules follow from the threat model. Each is enforced by infrastructure, not by instruction to the model.

1. **A model session is untrusted from the first token.** The session is set up by deterministic code, the model runs, and from then on everything in that session (files, git state, shell environment, installed tools) is treated as attacker-controlled. Output leaves as data and is checked before anything acts on it.
2. **No credential ever enters the sandbox.** Tokens are minted outside, used for one command as a header, and never written to the session. The only key the agent's role can resolve is the model key, and only through the service, never from the shell.
3. **Capability is granted by infrastructure, never by prompt.** What a role may do is fixed by IAM, a permissions boundary, the harness's tool allow-list and the harness version. The prompt explains the job; it is not a control.
4. **Every trust transition is an artefact.** Where work moves from one role to another, or from an agent to the orchestrator, it moves as a file the orchestrator reads, validates and stores. There is no shared mutable state between stages.
5. **Verification runs on trusted definitions.** Tests run from the workflow on the default branch, on a checkout of the work commit held as data, with no credentials. The pull request head is the commit that passed.
6. **One role, one purpose, one boundary.** Each agent role is its own harness, runtime, session and IAM role, with the smallest tool set that does its job. A boundary is crossed whenever the next session could have been written to by a model.
7. **Humans gate every irreversible step.** Nothing merges, deploys or promotes without a human approval that the system cannot grant itself.
8. **The control plane is least-privilege too.** The deploy role, the CloudFormation execution role and the boundaries are scoped to Factorial's own names, so even a compromised deployment cannot reach outside them.
9. **Nothing is deleted and everything is attributable.** The record of a run is write-once, redacted, and joined by one correlation key from trigger to pull request.

## 3. The layers

Each layer is independent: it stops a class of attack on its own, and it does not rely on the layers inside it holding. Together they are the defence in depth.

### 3.1 Account and deployment control plane

- The foundation stack is deployed once by a human. It creates the GitHub OIDC provider, the deploy role, the CloudFormation execution role and both permissions boundaries, and nothing else can change them.
- The deploy role trusts only GitHub Actions jobs from this repository, on `main`, in the `production` environment. A job without that environment presents a different OIDC subject and is refused. The repository and owner are identified by immutable id, not by name.
- The CloudFormation execution role can only create resources named `factorial-*`, and refuses to create or modify any IAM role that does not carry one of the two boundaries. A template cannot create an unbounded role by mistake.
- Only the deploy role may move a `live` alias. Every version is immutable, so promotion and rollback are both a pointer move, and in-flight work finishes on the version it started with.

### 3.2 Identity and credentials

- Factorial is a GitHub App, not a user token. Installation tokens are minted by orchestrator Lambdas for one repository and only the permissions the step needs, and expire within the hour:

  | Step | Token permissions |
  |---|---|
  | Prepare, CollectPlan (clone) | `contents: read` |
  | Prepare (fetch failing-check logs for rework) | `contents: read`, `actions: read` |
  | Collect (clean-room push) | `contents: write`, plus `workflows: write` only when the change edits a workflow |
  | OpenPullRequest | `contents: read`, `pull_requests: write`, `issues: write` |
  | Report | `issues: write` |

- A token is sent as an HTTP header on the single git command that needs it and is never written to disk or to the session's environment.
- Model provider keys live in AgentCore Identity's token vault. The agent's role may resolve them only with the `aws:ViaAWSService` condition, so the managed harness loop can fetch the key to call the model, but a shell command in the same session cannot read the secret.
- The GitHub App private key and the model keys are created by a human and referenced by name. They never pass through templates, parameters, the repository or logs.

### 3.3 The agent sandbox

- Each session is its own microVM, discarded when the run ends.
- The image is built from a base pinned by digest, holds no credentials and no credential helpers, and is tagged by the tree hash of its source so the running image is traceable to a commit.
- The agent execution role is held under `factorial-agent-permissions-boundary`, which allows model invocation, service-mediated credential resolution, web search through Factorial's own gateway, image pull and logging, and nothing else. The agent cannot reach the artefact store, the ledger, GitHub, Step Functions, CloudFormation or any other account resource, whatever its prompt says.
- The model, the tool allow-list, the iteration cap, the loop timeout and the output cap are fixed on the harness version. The invoker passes none of them at invoke time, so a run cannot be given more capability than its version declares.
- Every git command the orchestrator runs in a session uses a hardened environment: no system or global git config, no terminal prompt, no askpass helper. Nothing the agent writes to a config file can inject into those commands.
- Values that reach a session script from outside (owner, repository, branch, commit) are validated against strict patterns and shell-quoted before use, because they originate in a webhook payload.

### 3.4 Stage isolation and the clean room

This is the layer that makes the hostile-session rule real.

- **One harness per role.** The planner and the builder are separate harnesses with separate runtimes, sessions and IAM roles. They never share a filesystem. The planner's output (`plan.md`, `plan.json`) is read out by the orchestrator, validated against the plan contract, stored, and only then written into a fresh builder session cloned at the same commit. An invalid plan is retried once by the orchestrator, then the run ends; the model never decides that.
- **The builder's output leaves as a bundle.** After the build, the orchestrator exports the new commits as a git bundle and stores the session's files. It does not push from the builder's session.
- **The push happens in a clean room.** A separate session, which no model has run in, clones the repository afresh with hooks disabled, imports the bundle and checks that the imported head is exactly the commit the orchestrator expected, that the base commit is its ancestor, and that there are no merge commits. It then re-creates every commit with the App's bot identity, which discards whatever author, committer, signature or extra object the agent produced, and pushes a fast-forward to a `factorial/*` branch. A new branch must not already exist; a rework branch must still be at the head the session started from. No force push is ever issued.
- **Why the split matters.** A single container running every stage, with sub-agents sharing a filesystem, would let anything the builder planted (a git hook, a modified tool on `PATH`, a shell profile, a doctored test fixture) act on the stages after it, including a reviewer whose verdict the orchestrator trusts. Separate sessions make each role's input a stored artefact a human can read, and keep each role's tools and model enforceable by the harness version rather than by code running inside the sandbox. Roles may share a session only when neither of them can write: a read-only explorer and a planner, for example, but never the builder and anything that judges or ships its output.

### 3.5 Verification on trusted definitions

- Tests are run by dispatching `test.yml` on the default branch, so the workflow definition is always the one a human merged, never the one in the change under test.
- The job that runs the checks has `contents: read` only, checks out the work commit as data with `persist-credentials: false`, uses no Actions cache and sees no secrets. A separate job, which never touches the work commit, assumes the callback role through OIDC and reports the result to Step Functions. The task token in the inputs is useless without that role.
- The pull request step verifies that the branch head is the commit that was tested before it opens the PR. What was tested is what is proposed.
- Completion is signalled by infrastructure: the Fargate invoker task running to completion, and the Step Functions task token from the report job. The agent's own report that something worked is stored, but nothing acts on it.

### 3.6 Repository protection

- `main` is protected by a ruleset: changes land only through a pull request with an approving review from a code owner, both CI jobs must pass, and force pushes and deletions are blocked. The App is not a bypass actor, so even its `contents: write` token cannot reach `main`.
- Every pull request against Factorial's own repository is approved by a human. There is no privileged path for Factorial's changes to itself.
- The orchestrator pushes only to `factorial/*` branches.

### 3.7 The record

- Every stage writes its inputs and outputs to the artefact store under `<workItemId>/<attempt>/<stage>/`. The bucket is versioned, requires TLS, and its policy denies `DeleteObject` and `DeleteObjectVersion` to every principal. Retention is a lifecycle rule, never a permission someone could use.
- Only orchestrator Lambdas and the invoker hold the write policy, which grants `PutObject` and nothing else. No agent role can reach the bucket.
- Text is redacted before upload and before logging. The ledger holds status, usage and pointers, never content.
- One correlation key, the work item id, is the execution name, the session id, the artefact prefix, the ledger key and an attribute on every log line, so any run can be reconstructed afterwards from one value.

### 3.8 Untrusted input

- Issue text, repository contents, search results and CI logs are data. The prompts say so, but the layers above are what enforce it: an injected instruction can make the model try something, and the sandbox, the token scoping and the clean room are what make the attempt fail.
- Logs from failed checks are fetched outside the sandbox with a short-lived `actions: read` token, truncated to the last 200 lines and redacted before they are written into the rework session.
- Model output is never executed by the orchestrator. The orchestrator reads files with fixed names and size caps, validates structured output against a schema, and acts only on fields the schema defines.

## 4. How the layers combine

The point of defence in depth is that each likely failure is stopped more than once.

| Scenario | Stopped by |
|---|---|
| An issue says "push this straight to main" and the model tries | No token in the session (3.2). The push happens only from the clean room, only to `factorial/*` (3.4). The ruleset refuses the App on `main` regardless (3.6). |
| The builder installs a package whose postinstall script reads the environment | Nothing in the environment is worth reading (3.2, 3.3). The session's IAM role cannot reach any account resource (3.3). |
| The builder plants a git hook or edits a tool so the push or the tests do something else | Hooks are disabled and the clone is fresh in the clean room; commits are re-created from trees and messages only (3.4). Tests run from the definition on `main`, in a job with no credentials (3.5). |
| The change edits the test workflow to exfiltrate secrets | The dispatched workflow is `main`'s, not the change's (3.5). The only secrets are role ARNs, and both OIDC trusts are bound to `main`. |
| The model tries to deploy Factorial or move a `live` alias | The agent boundary has no such permission (3.3). The CloudFormation role refuses unbounded roles and foreign names (3.1). Only the deploy role may promote (3.1). |
| An orchestrator Lambda is compromised or buggy | Its role sits under the runtime boundary; its tokens are per step and per repository; its artefact access is write-only (3.2, 3.7). Its pushes still go through the ruleset (3.6). |
| A bad change to Factorial is merged | A human approved it (3.6). The previous version is immutable and `live` can be moved back (3.1). |
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
3. A GitHub App with per-step, per-repository tokens, and a ruleset on `main` that the App cannot bypass.
4. The clean-room push and the bundle hand-over, so no agent session ever holds a write token.
5. Tests dispatched from the trusted branch with the work commit as data.
6. One harness per role with the model and tools fixed on the version, so the first prompt written never has to be split later.
7. The write-once, redacted artefact store and the correlation key, so every run from the first one is reconstructable.
8. A non-root user in the agent image and an egress allow-list on the session network.

## 7. Where today's implementation falls short

These are the gaps between this design and what is deployed. Each is a candidate work item.

- **Sessions run as root.** The image runs as root inside the microVM, and the orchestrator's pre-invocation commands also run as root; the comment in `agent-environment/Dockerfile` records that a non-root user would create ownership mismatches with those commands. The microVM and the IAM role are the real boundary, but a non-root user is conventional practice and removes a class of mistakes, so it belongs in the design and should be done by running the orchestrator's commands as the same user.
- **Session egress is unrestricted.** Both harnesses use `NetworkMode: PUBLIC`. The session holds nothing to exfiltrate, but an allow-list (GitHub, the model endpoint, package registries) would limit what injected instructions can reach and is the stronger default.
- **The planner's read-only role is enforced by prompt.** The planner has the same built-in shell and file tools as the builder and is told not to write. The design calls for the harness version to withhold write tools from read-only roles once the harness supports that distinction.
- **A change that edits `.github/workflows/` is pushed with `workflows: write`**, and CI then runs the edited workflow on the pull request with the repository's secrets available. The secrets are role ARNs only and both OIDC trusts are bound to `main`, which limits the exposure; keep it that way and review workflow changes with care.
- **Branches other than `main` are unprotected**, so a `contents: write` token could push to them. The orchestrator pushes only to `factorial/*`, but nothing on the GitHub side enforces that for the App.
- **Traces are not yet exported**, so the correlation key does not yet reach AgentCore traces.
