# Architecture principles

These principles govern how Factorial is designed, built and evolved. They are not negotiable: a design, work item or pull request that conflicts with one of them is wrong, however convenient it is. Changing a principle is a deliberate decision made by the system designer through a reviewed pull request, never a side effect of other work.

`CLAUDE.md` records how the principles are currently enforced (the section **Fixed from day one** and the conventions). Where this document and an implementation disagree, the implementation is the thing to fix.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 1. Secure by default

Factorial generates and executes code from input it does not control: issue text, repository contents, logs, web pages and model output. Every layer MUST assume that input is hostile and MUST limit the damage a compromised layer can do. Security is designed in from the first version, never added afterwards.

In practice:

- Every role has the least privilege its step needs, scoped to one target and one purpose, and no credential is shared between roles.
- Credentials are held and used by deterministic code outside the agent sandbox. A model session never holds a credential, a signing key or a deployment permission, and nothing an agent produces is trusted with one.
- Once a model has run in a session, that session is treated as compromised: its output leaves as data and is checked before it is acted on.
- Agents MUST NOT be able to deploy or promote Factorial, and this is enforced by IAM, not by prompt.
- Anything the system reads from outside itself is untrusted input, including the text of the work it is asked to do.

## 2. Humans approve, the system proposes

Factorial proposes changes; people accept them. Every change the system makes to any codebase, including its own, lands as a pull request that a human approves. The system MUST NOT be able to merge, deploy or promote without that approval, and no stage of autonomy removes it.

In practice:

- There is no privileged path for Factorial's changes to itself. They go through the same loop, the same checks and the same human review as any other work.
- A human can stop, reject or roll back any run or version at any time, and that is a routine operation, not an emergency one.
- Key choices (which model, which design, what is in scope) are made or confirmed by people, and the system records who asked for what.

## 3. Verified, never trusted

An agent's output is a claim, not a result. Nothing becomes a pull request until it has been checked by means the agent cannot influence: tests, a sandbox deployment and a smoke test, run on trusted definitions outside the agent's session. An agent's own report that something works counts for nothing.

In practice:

- Verification runs on definitions taken from the trusted branch, never from the change under test.
- Completion and success are signalled by infrastructure the agent cannot forge, not by the agent.
- What was tested is what is proposed: the pull request head is the commit that passed.
- Coverage grows with the change: new behaviour arrives with new tests.

## 4. Deterministic orchestration, bounded agents

The flow of work is a fixed, inspectable graph run by a deterministic orchestrator. Agents run inside its stages, not around them. Each agent has an explicit purpose, tool set, model and limits, declared as configuration and fixed for a version.

In practice:

- The orchestrator decides what happens next; an agent never does.
- Deterministic work (cloning, testing, pushing, opening the pull request) is code, not a model prompt.
- Every agent has bounds on time, output and spend, and the orchestrator recovers whatever it produced when it stops, however it stops.
- Model configuration is part of the version, never supplied at invoke time.

## 5. Extensible through contracts

Factorial must grow as discoveries are made, technology choices change and the design evolves. Growth happens at defined extension points behind stable contracts, so a new trigger, context provider, agent role, model or integration is added without changing the core.

In practice:

- The `WorkItem` is Factorial's API. It is minimal, versioned and changed only by deliberate human decision.
- Each kind of extension (trigger adapter, context provider, external integration) has one well-defined shape, and adding an instance of it touches nothing downstream.
- Models and providers are interchangeable configuration per role. No part of the design depends on one vendor's model.
- A component is replaceable in isolation. If replacing one part means rewriting another, the boundary is in the wrong place.

## 6. Conventional by default

Technologies, services, patterns and structure SHOULD follow industry standards and the vendor's recommended practice. Managed services are preferred to bespoke code, and the smallest conventional solution is preferred to a clever one. Divergence is allowed only when it is written down with the reasons and references, so it can be revisited when the reasons change.

In practice:

- Everything is defined as code and deployed by pipeline. The only manual steps are the documented bootstrap and the human-held secrets.
- One language, one infrastructure format, one naming scheme and one deployment path.
- A divergence from convention is recorded alongside the design as a decision with context, options considered and consequences.

## 7. Transparent and observable

There is no magic box. Every decision, plan, design and artefact the system produces MUST be visible to its users, and every run MUST be reconstructable afterwards: what was asked, what the agents did, what it cost and why the result is what it is.

In practice:

- Every stage keeps its inputs and outputs. Plans, transcripts, summaries, logs and test results outlive the session that made them.
- One correlation key links a work item across triggers, executions, sessions, logs, traces and the ledger.
- Status, cost and failures are visible in one place without reading three consoles.
- The system explains itself in its pull requests: what it changed, why, what it tested and what it could not do.

## 8. Cost efficient and measured

Factorial justifies itself by producing accepted output at a cost below the alternative: a developer with a coding agent. If it cannot show that, the less autonomous approach wins. Cost is therefore measured per work item and treated as a design input, not an afterthought.

In practice:

- Every run records its model usage, compute and wall-clock time, so cost per accepted pull request is a known number.
- The cheapest model that does the task well is used for it; stronger models are reserved for the steps that need them.
- Work that cannot succeed stops early. Limits, fast failure and resumption from saved work are cheaper than long retries.
- Idle infrastructure costs nothing: serverless and on-demand compute by default.

## 9. Built by itself, one step at a time

Factorial builds Factorial. It starts from the smallest version that closes the loop and grows through its own work items, each one small enough to review and safe to reverse. Every version is immutable and addressed through a `live` alias, so promotion is moving a pointer and so is rollback.

In practice:

- The current stage is the specification. Target features are not built ahead of the stage that needs them.
- A successful deployment is what makes a version current; in-flight work finishes on the version it started with.
- Each change updates the documentation that describes the current state in the same pull request.
- The system's own history (what it tried, what was accepted, what it cost) is the input to its next improvement.
