# System diagram

The current implementation (Stage 0): a labelled GitHub issue becomes a tested pull request with no human step in between. `CLAUDE.md` is the authoritative description; this diagram shows the same system visually. Human-provided inputs (the bootstrap, the GitHub App) are shown greyed with dotted borders; everything else is deployed by the deploy workflow from the templates in `templates/`.

The four CloudFormation stacks are shown as subgraphs: `factorial-foundation` (`00`), `factorial-triggers` (`10`), `factorial-agent` (`20`) and `factorial-orchestration` (`30`). Arrows labelled **control** carry a trigger or an invocation; arrows labelled **data** carry the work itself.

```mermaid
flowchart TB
    classDef human fill:#f6f6f6,stroke:#999999,stroke-dasharray: 4 4,color:#555555

    %% ------------------------------------------------------------------ GitHub
    subgraph github["GitHub"]
        direction TB
        issue["Issue #N<br/>(this repository)"]
        webhooksignature["Webhook delivery<br/>(HMAC-signed)"]
        pr["Pull request<br/>(author: factorial[bot])<br/>awaiting human approval"]
        issue -->|"factorial label added<br/>(control)"| webhooksignature
    end

    %% ------------------------------------------------------------ Foundation
    subgraph foundation["Stack 00: factorial-foundation"]
        direction TB
        deployrole["factorial-deploy role<br/>(assumed by Actions, prod env)<br/>only principal that moves live aliases"]
        cfnrole["factorial-cloudformation role<br/>(scoped to factorial-* names)"]
        boundary["factorial-permissions-boundary<br/>and<br/>factorial-agent-permissions-boundary"]
        artefacts["S3 artefact bucket<br/>templates and Lambda bundles"]
        ecr["ECR repositories<br/>factorial/agent-environment<br/>factorial/agent-runtime<br/>factorial/invoker"]
    end

    deployrole -.->|"deploys all stacks<br/>(control)"| cfnrole
    cfnrole -.-> boundary
    deployrole -.->|"pushes images<br/>(data)"| ecr

    %% -------------------------------------------------------------- Triggers
    subgraph triggers["Stack 10: factorial-triggers"]
        direction TB
        adapter["Lambda: factorial-github-issues-adapter<br/>(live alias, function URL)<br/>verifies HMAC signature, checks<br/>allowed user IDs, validates WorkItem"]
        webhooksecret["Secrets Manager:<br/>factorial/github/webhook-secret"]
        bus["EventBridge bus:<br/>factorial-work"]
        adapter -->|"reads signing secret<br/>(control)"| webhooksecret
        adapter -->|"PutEvents:<br/>WorkItem event<br/>(data)"| bus
    end

    %% ----------------------------------------------------------------- Agent
    subgraph agent["Stack 20: factorial-agent"]
        direction TB
        builderruntime["AgentCore Runtime:<br/>factorial_builder<br/>host process + pi,<br/>plan and explore subagents,<br/>Sonnet 5.5 on Bedrock,<br/>immutable versions"]
        liveendpoint["Runtime endpoint 'live'<br/>(promoted by deploy workflow)"]
        agentrole["factorial-agent-builder role<br/>(agent permissions boundary:<br/>no GitHub, no PutEvents;<br/>named Bedrock profiles only)"]
        bedrock["Amazon Bedrock<br/>EU inference profiles"]
        reviewerruntime["AgentCore Runtime:<br/>factorial_reviewer<br/>same image and host, review mode,<br/>Sonnet 5.5 on Bedrock"]
        verifierruntime["AgentCore Runtime:<br/>factorial_verifier<br/>same image, no model;<br/>runs the target's declared checks<br/>as the agent user"]
        builderruntime --- agentrole
        builderruntime -->|"InvokeModel with<br/>the execution role<br/>(data)"| bedrock
        reviewerruntime -->|"InvokeModel with<br/>its execution role<br/>(data)"| bedrock
        liveendpoint --- builderruntime
    end

    %% --------------------------------------------------------- Orchestration
    subgraph orchestration["Stack 30: factorial-orchestration"]
        direction TB
        ledger["DynamoDB:<br/>factorial-work-items<br/>(idempotency + progress)"]
        sfn["Step Functions: factorial-work<br/>(live alias)<br/>Prepare → Build → Collect →<br/>HasChanges → Verify → Review →<br/>OpenPullRequest"]
        prepare["Lambda: factorial-prepare-seed<br/>(fetches and bundles the repo,<br/>seeds the session from the bundle,<br/>creates work branch)"]
        transfer["S3: factorial-transfer<br/>(repo bundles, presigned 5 min,<br/>expire after a day)"]
        invoker["Fargate task: factorial-invoker<br/>(ecs:runTask.sync, egress only)<br/>runs each agent to completion,<br/>streams transcript to logs"]
        collect["Lambda: factorial-collect-clean-room<br/>(commits leftovers, exports git<br/>bundle from hostile session,<br/>pushes from its own clean room)"]
        prepareverify["Lambda: factorial-prepare-verify<br/>(seeds a fresh verifier session<br/>at the pushed head, from a bundle)"]
        collectverifier["Lambda: factorial-collect-verifier<br/>(judges each verifier's result;<br/>a required failure stops Verify)"]
        openpr["Lambda: factorial-open-pr<br/>(verifies head = verified sha,<br/>opens PR, emits the outcome)"]
        report["Lambda: factorial-report<br/>(ends a turn with no PR,<br/>emits the outcome)"]
        reporter["Lambda: factorial-report-github<br/>(one comment per outcome,<br/>the started notice)"]
        sfn --> prepare
        sfn -->|"RunTask"| invoker
        sfn --> collect
        sfn --> prepareverify
        sfn --> collectverifier
        sfn --> openpr
        sfn --> report
    end

    bus -->|"rule factorial-work-item<br/>StartExecution on live alias<br/>(control)"| sfn

    github -->|"fetch with read token,<br/>in the Lambda<br/>(data)"| prepare
    prepare -->|"upload bundle<br/>(data)"| transfer
    prepare -->|"session command API:<br/>fetch from bundle by presigned URL<br/>(data)"| builderruntime
    transfer -->|"presigned GET<br/>(data)"| builderruntime
    invoker -->|"InvokeAgentRuntime<br/>qualifier 'live'<br/>(control)"| liveendpoint
    invoker -->|"InvokeAgentRuntime: review<br/>qualifier 'live'<br/>(control)"| reviewerruntime
    collect -->|"session command API:<br/>inspect, bundle<br/>(data)"| builderruntime
    collect -->|"push branch with<br/>App installation token<br/>(data)"| github
    prepareverify -->|"session command API:<br/>fetch from bundle<br/>(data)"| verifierruntime
    invoker -->|"session command API:<br/>run the declared check<br/>(control)"| verifierruntime
    openpr -->|"create PR<br/>(data)"| pr
    openpr -->|"PutEvents: Outcome<br/>(data)"| bus
    report -->|"PutEvents: Outcome<br/>(data)"| bus
    bus -->|"rules on source.type github-*<br/>(control)"| reporter
    reporter -->|"comment, reply,<br/>re-request review<br/>(data)"| pr

    prepare -.-> ledger
    invoker -.-> ledger
    collect -.-> ledger
    prepareverify -.-> ledger
    openpr -.-> ledger
    report -.-> ledger
    reporter -.-> ledger

    class webhooksecret human
```

## The loop, step by step

1. **Trigger.** A human adds the `factorial` label to an issue. GitHub delivers a signed webhook to the adapter's function URL on its `live` alias.
2. **Adapt.** The adapter verifies the HMAC signature, checks that both the issue author and the labeller are trusted user IDs, builds one `WorkItem` (contract v1) and puts it on the `factorial-work` bus.
3. **Start.** The single bus rule matches `source: factorial.triggers` / `detail-type: WorkItem` and starts an execution of the `factorial-work` state machine on its `live` alias, passing the `WorkItem` as input.
4. **Prepare** (Lambda, deterministic). Accepts the `WorkItem` exactly once in the ledger (idempotency guard), mints a read-only installation token, fetches the branches the session needs into its own `/tmp` and bundles them, uploads the bundle to the transfer bucket, and has the fresh builder session fetch from it by a five-minute presigned URL over the session command API (the session never reaches GitHub and no token enters it; #262), creates the work branch and leaves `workitem.json` on disk.
5. **Build** (Fargate, `runTask.sync`). Step Functions runs the invoker task and waits. The invoker reads the `WorkItem` from the ledger, invokes the `factorial_builder` Runtime on the `live` endpoint in that session, and streams the transcript to CloudWatch Logs. Factorial's host process runs pi there, with every tool the model calls running as the unprivileged `agent` user. The builder first plans with its read-only plan subagent and writes `plan.json` and `plan.md`, which the host checks against the plan contract; the agent edits the code inside the sandbox, which holds no credentials beyond the execution role's model access.
6. **Collect** (Lambda, deterministic). Treats the session as hostile: validates and stores the builder's plan (no valid plan → **report** `invalid-plan`), commits anything uncommitted, exports the commits as a git bundle, and pushes the branch itself, from a pristine clone in its own `/tmp` with hooks disabled, using a fresh installation token that never enters a session.
7. **HasChanges** (Choice). No pushed commits → **report** (`no-changes`) and finish.
8. **Verify** (Map, one verifier at a time). For each check the base branch declares in `.factorial/verifiers.json`, PrepareVerify seeds a fresh `factorial_verifier` session at the pushed head from a bundle, the invoker runs the check there as the unprivileged user with no credentials and stores its result, and CollectVerifier judges it. A required verifier that does not pass → **report** (`tests-failed`) and fail. No file → the pull request says it was not verified.
9. **Review**. A fresh `factorial_reviewer` session judges the change; advisory.
10. **OpenPullRequest** (Lambda). Confirms every required verifier passed on the branch head and that it is still that commit, opens the PR attributed to `factorial[bot]`, and emits the turn's `Outcome`; `factorial-report-github` comments on the issue (#165). A human reviews and approves.

## Versioning and promotion

Each part is independently versioned and referenced only through its `live` alias; templates create the aliases but never move them.

| Part | Versioned resource | `live` pointer |
|---|---|---|
| Agents | Runtime versions (builder, reviewer, verifier) | Endpoint named `live` |
| State machine | Step Functions versions | Alias named `live` |
| Adapters and Lambdas | Lambda versions | Alias named `live` |

The deploy workflow (GitHub Actions assuming `factorial-deploy`) is the only principal that promotes: it moves every runtime's `live` endpoint to the newest READY version as its final step, so the next `WorkItem` is handled by the newly deployed version. Lambda aliases and the state machine alias move during the deploy itself; separating all three promotions comes with the staging canary (a known Stage 0 gap).
