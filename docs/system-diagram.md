# System diagram

The current implementation (Stage 0): a labelled GitHub issue becomes a tested pull request with no human step in between. `CLAUDE.md` is the authoritative description; this diagram shows the same system visually. Human-provided inputs (the bootstrap, the GitHub App, the model key) are shown greyed with dotted borders; everything else is deployed by the deploy workflow from the templates in `templates/`.

The four CloudFormation stacks are shown as subgraphs: `factorial-foundation` (`00`), `factorial-triggers` (`10`), `factorial-agent` (`20`) and `factorial-orchestration` (`30`). Arrows labelled **control** carry a trigger or an invocation; arrows labelled **data** carry the work itself.

```mermaid
flowchart TB
    classDef human fill:#f6f6f6,stroke:#999999,stroke-dasharray: 4 4,color:#555555

    %% ------------------------------------------------------------------ GitHub
    subgraph github["GitHub"]
        direction TB
        issue["Issue #N<br/>(this repository)"]
        webhooksignature["Webhook delivery<br/>(HMAC-signed)"]
        testwf["test.yml run<br/>(dispatched on main,<br/>trusted definition)"]
        pr["Pull request<br/>(author: factorial[bot])<br/>awaiting human approval"]
        oidc["GitHub OIDC token<br/>(sub: repo:ref:main)"]
        issue -->|"factorial label added<br/>(control)"| webhooksignature
    end

    %% ------------------------------------------------------------ Foundation
    subgraph foundation["Stack 00: factorial-foundation"]
        direction TB
        deployrole["factorial-deploy role<br/>(assumed by Actions, prod env)<br/>only principal that moves live aliases"]
        cfnrole["factorial-cloudformation role<br/>(scoped to factorial-* names)"]
        boundary["factorial-permissions-boundary<br/>and<br/>factorial-agent-permissions-boundary"]
        artefacts["S3 artefact bucket<br/>templates and Lambda bundles"]
        ecr["ECR repositories<br/>factorial/agent-environment<br/>factorial/invoker"]
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
        modelkey["AgentCore Identity:<br/>factorial-model-api-key<br/>reads human-created secret"]
        harness["AgentCore Harness:<br/>factorial_builder<br/>GLM 5.3 Flash via Z.ai API,<br/>immutable versions"]
        liveendpoint["Harness endpoint 'live'<br/>(promoted by deploy workflow)"]
        agentrole["factorial-agent role<br/>(agent permissions boundary:<br/>no GitHub, no PutEvents)"]
        harness --- agentrole
        harness -->|"GetResourceApiKey<br/>(control)"| modelkey
        liveendpoint --- harness
    end

    %% --------------------------------------------------------- Orchestration
    subgraph orchestration["Stack 30: factorial-orchestration"]
        direction TB
        ledger["DynamoDB:<br/>factorial-work-items<br/>(idempotency + progress)"]
        sfn["Step Functions: factorial-work<br/>(live alias)<br/>Prepare → Build → Collect →<br/>HasChanges → Test → OpenPullRequest"]
        prepare["Lambda: factorial-prepare<br/>(accepts WorkItem once,<br/>clones repo into session,<br/>creates work branch)"]
        invoker["Fargate task: factorial-invoker<br/>(ecs:runTask.sync, egress only)<br/>runs the harness to completion,<br/>streams transcript to logs"]
        collect["Lambda: factorial-collect<br/>(commits leftovers, exports git<br/>bundle from hostile session,<br/>pushes from clean-room session)"]
        dispatch["Lambda: factorial-dispatch-tests<br/>(dispatches test.yml on main<br/>with task token + tested sha)"]
        openpr["Lambda: factorial-open-pr<br/>(verifies head = tested sha,<br/>opens PR, comments on issue)"]
        report["Lambda: factorial-report<br/>(tells the requester when<br/>no PR will follow)"]
        callbackrole["factorial-test-callback role<br/>(OIDC, main only,<br/>SendTask* only)"]
        sfn --> prepare
        sfn -->|"RunTask"| invoker
        sfn --> collect
        sfn --> dispatch
        sfn --> openpr
        sfn --> report
    end

    bus -->|"rule factorial-work-item<br/>StartExecution on live alias<br/>(control)"| sfn

    prepare -->|"session command API:<br/>clone with token as header<br/>(data)"| harness
    invoker -->|"InvokeHarness<br/>qualifier 'live'<br/>(control)"| liveendpoint
    harness -->|"model calls<br/>(data)"| agent
    collect -->|"session command API:<br/>inspect, bundle<br/>(data)"| harness
    collect -->|"push branch with<br/>App installation token<br/>(data)"| github
    dispatch -->|"workflow_dispatch<br/>(control)"| testwf
    testwf --> oidc
    oidc -->|"sts:AssumeRoleWithWebIdentity<br/>(control)"| callbackrole
    callbackrole -->|"SendTaskSuccess /<br/>SendTaskFailure<br/>(control)"| sfn
    openpr -->|"create PR, comment<br/>(data)"| pr

    prepare -.-> ledger
    invoker -.-> ledger
    collect -.-> ledger
    dispatch -.-> ledger
    openpr -.-> ledger
    report -.-> ledger

    class modelkey,webhooksecret human
```

## The loop, step by step

1. **Trigger.** A human adds the `factorial` label to an issue. GitHub delivers a signed webhook to the adapter's function URL on its `live` alias.
2. **Adapt.** The adapter verifies the HMAC signature, checks that both the issue author and the labeller are trusted user IDs, builds one `WorkItem` (contract v1) and puts it on the `factorial-work` bus.
3. **Start.** The single bus rule matches `source: factorial.triggers` / `detail-type: WorkItem` and starts an execution of the `factorial-work` state machine on its `live` alias, passing the `WorkItem` as input.
4. **Prepare** (Lambda, deterministic). Accepts the `WorkItem` exactly once in the ledger (idempotency guard), mints a read-only installation token, clones the repository into a fresh harness session by the session command API (token sent as a header, never written into the session), creates the work branch and leaves `workitem.json` on disk.
5. **Build** (Fargate, `runTask.sync`). Step Functions runs the invoker task and waits. The invoker reads the `WorkItem` from the ledger, invokes the `factorial_builder` harness on the `live` endpoint in that session, and streams the transcript to CloudWatch Logs. The agent edits the code inside the sandbox, which holds no credentials.
6. **Collect** (Lambda, deterministic). Treats the session as hostile: commits anything uncommitted, exports the commits as a git bundle, and pushes the branch from a clean-room session with hooks disabled, using a fresh installation token.
7. **HasChanges** (Choice). No pushed commits → **report** (`no-changes`) and finish.
8. **Test** (Lambda + callback). Dispatches `test.yml` on the default branch with the task token and the tested commit sha. The checks job runs the untrusted commit with no credentials; the report job assumes `factorial-test-callback` through OIDC (main only) and sends task success or failure. Failure → **report** (`tests-failed`) and fail.
9. **OpenPullRequest** (Lambda). Confirms the branch head is still the tested commit, opens the PR attributed to `factorial[bot]`, and comments on the issue. A human reviews and approves.

## Versioning and promotion

Each part is independently versioned and referenced only through its `live` alias; templates create the aliases but never move them.

| Part | Versioned resource | `live` pointer |
|---|---|---|
| Agents | Harness versions | Harness endpoint named `live` |
| State machine | Step Functions versions | Alias named `live` |
| Adapters and Lambdas | Lambda versions | Alias named `live` |

The deploy workflow (GitHub Actions assuming `factorial-deploy`) is the only principal that promotes: it moves the harness `live` endpoint to the newest version as its final step, so the next `WorkItem` is handled by the newly deployed version. Lambda aliases and the state machine alias move during the deploy itself; separating all three promotions comes with the staging canary (a known Stage 0 gap).
