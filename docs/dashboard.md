# The command centre

A live, read-only operations console for one reviewer (#57, #58 and #59). It is a Next.js app in `packages/dashboard`, run on the reviewer's own machine with their own AWS credentials. It deploys nothing and needs no foundation change. `docs/mockups/command-centre.html` is the specification for its layout and interaction: change both together.

## Running it

```sh
npm ci
AWS_PROFILE=<your profile> npm run dashboard
```

It builds the app on first run, starts it on `127.0.0.1:4757` and prints a URL with a token that is new on every start. Open that URL; nothing is served without it. `npm run dashboard -- --dev` runs the development server instead.

Ctrl-C stops it, within 5 seconds at most. The server ends every tab's live stream and exits; if it is still running 5 seconds after the first Ctrl-C (or `SIGTERM`) the launcher kills it, and a second Ctrl-C kills it at once. The command centre is read-only and holds no state, so a forced stop loses nothing. Browsers see the stream end and the status bar shows the feed as down.

| Variable | Default |
|---|---|
| `DASHBOARD_PORT` | `4757` |
| `FACTORIAL_LIVE_HTTP_DOMAIN`, `FACTORIAL_ARTEFACT_BUCKET`, `FACTORIAL_STATE_MACHINE_ARN` | the `factorial-orchestration` stack's outputs `LiveHttpDomain`, `WorkArtefactsBucketName`, `WorkStateMachineArn`, as `scripts/tail-run.ts` finds them |
| `FACTORIAL_WORK_ITEMS_TABLE`, `FACTORIAL_THREADS_TABLE` | the stack's `WorkItemsTableName` and `ThreadsTableName`, else `factorial-work-items` and `factorial-threads` |
| `FACTORIAL_REPOSITORY` | `JamieGeddes/factorial`, where `FactorialVersion` is a commit and `deploy.yml` runs |
| `GITHUB_TOKEN` | unset. Any token (no scope needed: the repository is public) raises the GitHub API's limit from 60 requests an hour to 5,000; it is sent to `api.github.com` only, from the server |

Credentials come from the AWS SDK's default chain (`AWS_PROFILE`, SSO, environment variables). Region `eu-west-1`.

## The access it needs

An administrator profile works. A read-only identity needs exactly this, which is also the policy for the Fargate task role described below (replace `<account id>`, and take the two AppSync ARNs from the stack's outputs `LiveApiArn` and `LiveNamespaceArn`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Ledger", "Effect": "Allow", "Action": ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:DescribeTable"], "Resource": ["arn:aws:dynamodb:eu-west-1:<account id>:table/factorial-work-items", "arn:aws:dynamodb:eu-west-1:<account id>:table/factorial-threads"] },
    { "Sid": "ArtefactList", "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::factorial-work-artefacts-<account id>" },
    { "Sid": "ArtefactRead", "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::factorial-work-artefacts-<account id>/*" },
    { "Sid": "Stacks", "Effect": "Allow", "Action": "cloudformation:DescribeStacks", "Resource": ["arn:aws:cloudformation:eu-west-1:<account id>:stack/factorial-orchestration/*", "arn:aws:cloudformation:eu-west-1:<account id>:stack/factorial-agent/*"] },
    { "Sid": "RuntimeVersions", "Effect": "Allow", "Action": ["bedrock-agentcore:GetAgentRuntimeEndpoint", "bedrock-agentcore:ListAgentRuntimeVersions"], "Resource": "arn:aws:bedrock-agentcore:eu-west-1:<account id>:runtime/factorial_*" },
    { "Sid": "Alarms", "Effect": "Allow", "Action": "cloudwatch:DescribeAlarms", "Resource": "arn:aws:cloudwatch:eu-west-1:<account id>:alarm:factorial-*" },
    { "Sid": "Metrics", "Effect": "Allow", "Action": "cloudwatch:GetMetricData", "Resource": "*" },
    { "Sid": "Executions", "Effect": "Allow", "Action": "states:ListExecutions", "Resource": "arn:aws:states:eu-west-1:<account id>:stateMachine:factorial-work" },
    { "Sid": "LiveAlias", "Effect": "Allow", "Action": "states:DescribeStateMachineAlias", "Resource": "arn:aws:states:eu-west-1:<account id>:stateMachine:factorial-work:live" },
    { "Sid": "InvokerTasks", "Effect": "Allow", "Action": "ecs:ListTasks", "Resource": "*", "Condition": { "ArnEquals": { "ecs:cluster": "arn:aws:ecs:eu-west-1:<account id>:cluster/factorial-build" } } },
    { "Sid": "Quotas", "Effect": "Allow", "Action": ["servicequotas:ListServiceQuotas", "servicequotas:GetServiceQuota"], "Resource": "*" },
    { "Sid": "LogsQuery", "Effect": "Allow", "Action": "logs:StartQuery", "Resource": ["arn:aws:logs:eu-west-1:<account id>:log-group:/aws/lambda/factorial-github-issues-adapter:*", "arn:aws:logs:eu-west-1:<account id>:log-group:/factorial/invoker:*"] },
    { "Sid": "LogsResults", "Effect": "Allow", "Action": ["logs:GetQueryResults", "logs:StopQuery"], "Resource": "*" },
    { "Sid": "LiveConnect", "Effect": "Allow", "Action": "appsync:EventConnect", "Resource": "<LiveApiArn>" },
    { "Sid": "LiveSubscribe", "Effect": "Allow", "Action": "appsync:EventSubscribe", "Resource": "<LiveNamespaceArn>" }
  ]
}
```

`cloudwatch:GetMetricData`, `logs:GetQueryResults`, `logs:StopQuery` and the two Service Quotas reads take no resource, and `ecs:ListTasks` is scoped by its cluster condition. The bucket is encrypted with S3-managed keys, so no KMS permission is needed.

**GitHub.** The only GitHub API the command centre reads is the deploy workflow's runs on Factorial's own repository, which is public: the runs list, each finished run's jobs and its deploy job's annotations (`src/server/github.ts`). A finished run is read once per process; the list every two minutes, so a cold start costs at most 21 requests against the anonymous 60 an hour. It never holds the GitHub App's credentials, so the App's own delivery log and rate limit are not shown. Every other GitHub link is built from the ledger's repository fields.

To create it in the console: **IAM** → left nav **Policies** → **Create policy** → **JSON** → paste the policy with the values filled in → **Next** → name it `factorial-dashboard-read` → **Create policy**. Then **IAM** → left nav **Users** (or **Roles**) → the identity → **Permissions** tab → **Add permissions** → **Attach policies directly** → tick `factorial-dashboard-read` → **Next** → **Add permissions**.

## Localhost protections

The server acts with the reviewer's credentials, so any page in their browser that could reach it could read everything. All of this is in `src/server/guard.ts` and `src/proxy.ts`, the part a hosted version replaces:

- It binds to `127.0.0.1` only (`next start --hostname 127.0.0.1`).
- A request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` gets 403, which defeats DNS rebinding.
- The URL printed at start carries a random token. The first request exchanges it for an `HttpOnly`, `SameSite=Strict` cookie holding a digest of the token, and redirects to the same page without the token. Every request without the cookie gets 401, static files included.
- A request other than `GET` (only the live stream's channel change) must also carry the app's own `Origin`.
- Every page has a Content-Security-Policy with a per-request nonce, `'strict-dynamic'` and `frame-ancestors 'none'`, set as the Next.js documentation sets it up. Inline `style` attributes are allowed (`style-src-attr`), for chart and meter geometry.

**Untrusted content.** Everything a model, a tool or a requester wrote is rendered by React as text: never `dangerouslySetInnerHTML`, never Markdown turned into HTML. Control and bidirectional characters are removed first (`src/lib/sanitise.ts`, as `sanitise` in `scripts/tail-run.ts`). The only links are those the app builds itself (`src/lib/links.ts`): GitHub URLs from the repository fields and AWS console URLs from well-formed ARNs. An artefact is sent as JSON, NDJSON, plain text or `application/octet-stream`, never HTML, with `nosniff` and `Content-Security-Policy: sandbox`.

## How it is built

- **Server-only modules** (`import 'server-only'`) in `src/server/` hold all AWS and GitHub access, one per source: `ledger.ts`, `threads.ts`, `artefacts.ts`, `usage-records.ts`, `live.ts` (with `live-connection.ts`), `stacks.ts`, `runtimes.ts`, `cloudwatch.ts`, `stepfunctions.ts`, `ecs.ts`, `quotas.ts`, `logs.ts`, `table.ts` and `github.ts`; `ops.ts` gathers the Health view's AWS reads. Route handlers call them through `handlers.ts`; nothing else touches an SDK. `services.ts` builds them once per process.
- **Caching**, in memory only: a finished item's artefacts and every catch-up chunk are kept for the life of the process (256 MiB in all), and so are each run's `usage.json` facts and each finished deploy run's jobs and annotations; ledger and thread scans for 5 seconds; the Metrics view per range and repository for 10 seconds; stack outputs, Runtime endpoints, the Health view's metrics, Logs Insights queries, executions and tasks for 60 seconds; CloudWatch alarms and the bus rate for 30 seconds; the deploy runs list for 2 minutes; Runtime version times for 10 minutes; quotas and `DescribeTable` for 6 hours. Nothing is written to disk. A 90-day Metrics view on a warm cache returns in milliseconds; the first, which reads every run's `usage.json` in the range 24 at a time, took 0.3 seconds on 2026-10-31's ledger.
- **Browser bundles** import nothing from `src/server/` and only `@factorial/live/channels` from `@factorial/live`, never `sign.ts` and the Node credential chain; a test checks it. The ledger types in `src/lib/records.ts` mirror `@factorial/progress` rather than import it, because that module brings ajv and the contract schema.
- **Tests** run on the source under `node --test`, with `test/register.ts` compiling `.tsx` through esbuild and stubbing `server-only`. Route handlers and server modules are tested with stubbed AWS clients.

### Data routes

All `GET` and JSON unless stated; each returns exactly what its view needs.

| Route | Returns |
|---|---|
| `/api/work-items?filter=&source=&q=&limit=&cursor=` | The Work items view's rows, running and waiting first, then newest first; the source types the ledger holds; running and waiting counts. `filter` is `all`, `running`, `waiting`, `finished`, `attention` or `refused`. |
| `/api/work-items/{id}` | The ledger row, its thread and a listing of every object under `<id>/`. |
| `/api/work-items/{id}/artefacts/{key}` | One object under `<id>/`, `key` relative to it: no `..`, no other item. A finished item's is read whole and kept; a running item's is streamed. |
| `/api/overview` | The Overview: tiles, each stage's p50 and p90, the pucks, the Attention notices, the agent sessions running, the 14-day throughput and spend, and today's recently finished. |
| `/api/runs/{id}/{stage}/{round}` | One run's header and side panels: the item's stages as work and wait, the run's live record or record, its limits, its plan, the runs to switch to, and the artefact route of its `transcript.jsonl` once it has ended. |
| `/api/running` | Items with no `result` yet, created since #165 (`RESULT_SINCE` in `src/lib/status.ts`), with their `live` record. |
| `/api/status` | The status bar: the live version, each Runtime's `live` version, the bus rate, the alarms and the running counts. |
| `/api/metrics?range=&repository=` | The Metrics and cost view (#59): `range` is 7, 30 (the default) or 90 days ending today; `repository` is `owner/name`, or empty for all. Tiles, every chart's series and the Runtime versions table, ready to draw. |
| `/api/health` | The Health view (#59): each component's status, what it reported and a figure; the alarms; the quota meters; the deploy runs; the webhook deliveries per hour. A source that fails is a warning on its own row, never a failed response. |
| `/api/live?channels=` | Server-sent events, below. |
| `POST /api/live/{stream}` | `{ "channels": [...] }`: changes one tab's channels. It writes nothing; the set lives in the process. |

### The live stream

One server-sent events stream per browser tab, multiplexed: the page names its channels (`/factorial/work-items`, `/factorial/work-items/<id>`, `/factorial/runs/<id>/<stage>/<round>`; at most eight) and changes them without reconnecting, which keeps within the browser's per-origin connection limit. The server holds one WebSocket to `factorial-live` and one subscription per channel however many tabs want it, dropped 10 seconds after the last tab leaves.

A run channel is delivered from its first event: the server subscribes, reads the run's catch-up chunks from `0001`, merges both by `seq` with `OrderedFeed` and keeps what it has sent, so every tab gets each event once, in order, from `seq` 1, then live until `run.ended`. Chunks are read a second after subscribing, then every 5 seconds until the run has ended with no gap. If the ledger says the run or its item has ended and three reads find nothing new, the channel reads `incomplete`. A chunk's line is put in the same envelope as a channel event (`liveEnvelope`, capped the same way). The connection reconnects with backoff (1 s doubling to 30 s, `down` after five failures in a row, still retrying), subscribes again to every channel and reads the chunks again, so a reconnect leaves no gap and repeats nothing. Progress messages are relayed as they come, repeats dropped by `eventId`.

Each message is `{ kind: 'event', channel, envelope }`, `{ kind: 'progress', channel, message }`, `{ kind: 'state', state, channels }` (the connection's state and, per channel, events sent, chunks read, `ended`, `incomplete`) or the first, `{ kind: 'hello', stream }`.

## Where every panel's data comes from

| Panel | Source |
|---|---|
| Rail: Work items count | `/api/running`'s rows: running and waiting. |
| Rail foot: live version | `FactorialVersion`, a parameter of `factorial-orchestration`, linked to its commit. |
| Rail foot: Builder, Reviewer | The agent stack's `*RuntimeId` outputs, and `GetAgentRuntimeEndpoint` on each `live` endpoint for `liveVersion`. |
| Status bar: live feed | The tab's stream's state: connecting, connected, reconnecting, down. |
| Status bar: bus rate | CloudWatch `AWS/Events` `Invocations` summed over every rule on `factorial-work`, per minute over the last ten. |
| Status bar: alarms | CloudWatch alarms named `factorial-*`: how many are in `ALARM`, or "none set up, #16" when there are none. |
| Work items: every column | The ledger row (`workItem`, `status`, `result`, `route`, `refusedReason`, `branch`, `prNumber`, `savedWork`, `stages`, `live`, `reviewVerdict`, `reviewScores`, `attempt`, `createdAt`, `endedAt`) and its thread's `outcome` (merged or closed). Cost sums `stages.*.run.costUsd`, plus `live.costUsd` for a run not yet recorded. Refreshed on every message on `/factorial/work-items`, and every 20 seconds. A row opens the item's latest run, or the item while it has none. |
| Work item detail | The row, its thread and the artefact listing; its Build and Review stages link to their runs, and the latest agent run's card opens it. The header shows an `<n> build rounds` tag (`buildRounds`) when an item took more than one round; the Stages table shows under each stage with a `run` one line of runtime, turns, tool calls and stop reason (`runLine`), the stop reason amber for an incomplete run and red for a failed one. All from the same row, no extra call; the text is sanitised as untrusted. |
| Overview: tiles | Every ledger row and thread (`overview` in `src/lib/overview.ts`), days in the machine's local time, each with eight days of sparkline. In flight: rows with no `result`, and their repositories. Finished today: results whose `endedAt` is today, against yesterday. Pull requests opened: today's `pr-opened`, merged or awaiting review by the thread's `outcome`. Model spend and tokens today: `costUsd` and `usage` of every run entry that ended today, plus a running run's `live` figures until its entry records them; spend against the previous seven days' mean, tokens with the cache hit rate (cache reads over input). No budget figure until #63. Median issue to PR: the WorkItem's `createdAt` to its `pr-opened` result's `endedAt`, today against the previous seven days. |
| Overview: stage graph | Each stage's p50 over its last 30 finished entries (every build round is one), and a puck per item in flight on its current stage (`SaveWork` and `ContinueBuild` count as Build), styled builder, reviewer (in Review), rework (a pull request or workflow run source) or waiting (in Test), with its build round above 1. A `started` progress event moves the puck at once, sliding unless the reader asked for reduced motion; an `ended` WorkItem event removes it; the next read confirms both. A puck opens the item's latest run. |
| Overview: Attention | The last hour, newest first: refusals with their reason and the item holding the thread (`inFlight` on `factorial-threads`); failed outcomes (`failed`, `tests-failed`, `invalid-plan`); a running item whose `live.at` is more than a minute old; an item in Test past the Test stage's p90; CloudWatch alarms in `ALARM`, with when they entered it; and, from each running session's channel, model call retries (`model.retry`), which read as stopped five minutes after the last. Deploys in the last hour, from the deploy runs (#59): a failure as critical, a deploy with the stacks and versions it records, one running. |
| Overview: agent sessions running | One row per running run, from the row's `live` record: role and round, elapsed (from the stage entry's start), turns, budget and time against `live.limits`, tokens, and the last event from the run's channel (which also counts the main loop's model calls as turns until the record has them). An item in Test has its own row, with its workflow run when `testRunUrl` names one in the item's repository. |
| Overview: charts and recently finished | Results per day for 14 days (pull request opened, updated, no pull request); each stage's p50 with its p90 marker; run cost per day for 14 days; today's last six results, each opening its run. The view is read again on every progress message (at most once a second) and every 20 seconds. |
| Run & transcript: header and side panels | `/runs/<id>/<stage>/<round>` (`/runs` lists every item's latest run, running first). The header: reference, title, status, ids, and links to the execution, the artefact prefix in the S3 console, the pull request and the item. Stages: each entry's work (its own duration, growing while it runs) and wait (the gap since the previous stage ended), then the stages not reached. Limits: turns, budget and time against the run's `live.limits`, or once it has ended its `usage.json`. Usage and the turn count come from the events as they arrive (summed per call, then `run.ended`'s totals), from the ledger before. Session: the run entry's Runtime and version, the harness and models from `run.started`. Plan: `plan/plan.json` once Collect has stored it; before then, for a build, the builder's last write of `plan.json` in the run's catch-up chunks, which hold it uncut. Nothing records which step the builder is on, so the steps show without progress. Read again on progress for the item, when a plan write arrives, and every 15 seconds while the run goes on. |
| Run & transcript: transcript | A finished run's `transcript.jsonl` through the artefact route, read as a stream and parsed in slices; a running run's channel, from `seq` 1 (and the channel too when there is no transcript). Each event as the mockup renders it, with its `seq` and time; a field the live feed cut is marked with its full size; a subagent's events carry its mark. Filters, a search through every event, Follow (off once the reader scrolls up), Jump to latest and Pause (events still kept). Only the rows in view are rendered, so a 10 MB transcript (25,000 events) loads in under half a second without a long task over 100 ms. The footer names the channel and its state, the event count and the catch-up chunks read. |
| Metrics & cost: tiles | Over the range and repository, items by their end and runs by their entry's end. Cost per pull request: the median of an item's run `costUsd` over items that opened or updated one and recorded a cost (rows from before #15 hold none). Issue to PR: median and p90 of the WorkItem's `createdAt` to its `pr-opened` end. PR merge rate: opened pull requests whose thread's `outcome` is `merged`, over those opened; `–` while no thread records an outcome. Rework turns per PR: items whose source is a workflow run (automatic) or a pull request review or comment (requested), per pull request opened. Builds needing rounds: items with a build round above 1, and how many builds stopped on `max_turns`. Model call retries: `usage.json`'s `retries`, recorded since #59, and how many of those runs still failed. Each sparkline is the same figure over eight slices of the range. |
| Metrics & cost: charts | Tokens per day by model (per week over 90 days): input plus output per model from `usage.json`'s `harness.models` (subagents included), else the run entry's model and usage; at most five models and the rest as "Other". Cost per work item by role: the last 20 finished items that ran an agent, each run's `costUsd` by its role. Outcomes: each item's result, `failed` with saved work as Incomplete. Review scores: the weekly mean of each `reviewScores` key. Model latency and retries: the p50 of each model's calls' `durationMs` per day, and `retries` per day; runs without per-call durations (before #59) are left out, with a note. |
| Metrics & cost: Runtime versions compared | One row per `runtimeVersion` on the run entries in the range, builder or reviewer: promoted (the deploy run whose `Runtimes promoted` notice names it, else the version's `lastUpdatedAt` from `ListAgentRuntimeVersions`, its creation), harness and model from the entry, runs, PR rate over its finished items, median run duration, mean build rounds (builder), its runs' cost per pull request, and the mean of its items' review scores. |
| Health: components | Checked every minute. GitHub adapter: Lambda `Invocations` and `Errors` on the `live` alias over 24 hours, and the `delivery` lines. Event bus: the rules' `Invocations` and `FailedInvocations` over 24 hours, and the bus rate. State machine: `ListExecutions` running, and failed since local midnight; the `live` alias's version (`DescribeStateMachineAlias`). Fargate invoker: running tasks in `factorial-build` (`ListTasks`); start latency p50, Prepare's end to Build's start over the last 30 items that built. Runtimes: each `live` endpoint's version and status; sessions from the ledger's `live` records. Bedrock, per model the last 7 days' runs name: `model call retried` lines in the last 15 minutes by `runModel` (Logs Insights on `/factorial/invoker`), and the peak minute of `EstimatedTPMQuotaUsage` in the last hour against the tokens-per-minute quota of the same name. Artefact store: `BucketSizeBytes` and `NumberOfObjects` (daily), and the stages the ledger says started today. Ledger: `ThrottledRequests` over 24 hours and `DescribeTable`'s item count (refreshed by DynamoDB about every six hours). Live feed: the server's stream state, and `published` and `dropped` from the `usage.json` of runs that ended in 24 hours. Traces: off until #56. |
| Health: alarms | `DescribeAlarms` for `factorial-*`, with state and reason; not set up until #16 adds them. |
| Health: quotas | The peak minute in the last hour against the account's limit: Bedrock tokens per minute per model in use (`EstimatedTPMQuotaUsage`), requests per minute where such a quota exists (none for the models in use today), Fargate On-Demand vCPU and AgentCore active session workloads (each quota's own usage metric), and the live feed's inbound events per second (AppSync `InboundMessages` against "Event APIs - Rate of inbound events per API"). Quotas with no usage metric are listed as left out. |
| Health: deploys and promotions | The last ten `deploy.yml` runs on `main`: commit, when, the merged pull request's title, the stacks from the deploy job's `Stacks deployed` notice, the versions from its `Runtimes promoted` notice, and the outcome (deployed, skipped when the deploy job was skipped, failed, cancelled or running, with the attempt when re-run). Runs before #59 record neither notice and show –. |
| Health: webhook deliveries | Logs Insights on the adapter's `delivery` lines over 24 hours, per hour by `outcome`, and the ignored ones by `reason` with quoted names and numbers folded; failed adds the Lambda's `Errors`. Before #59's deploy there are none, and the panel says so. |

**The status mapping** (`statusPill` in `src/lib/status.ts`) is used everywhere. A turn has ended once its row has a `result`; a row created before #165 reached `main` never got one, so it has ended whatever it holds and its `status` stands in for the result. A running item in Build or Review reads `building` or `reviewing` (with the round above 1), in Test `testing` (styled as waiting: no agent in session), in any other stage the stage's name; `failed` with saved work reads `incomplete` and names the branch; `refused` carries its code and reason. A running item whose `live.at` is more than a minute old is stale: its invoker has stopped, and it appears under Needs attention.

## Intended architecture (later, not this work)

The command centre is expected to move to Fargate, like the other apps its owner runs: the same Next.js server built with `output: 'standalone'` into an image. What would change then:

- **Sign-in.** `src/server/guard.ts` and `src/proxy.ts` are replaced by real sign-in: the ALB's OIDC authentication, or middleware against the chosen identity provider.
- **Credentials.** A `factorial-dashboard` task role replaces the reviewer's profile, with the policy above. It holds `appsync:EventConnect` and `appsync:EventSubscribe`, and the runtime permissions boundary allows only `appsync:EventPublish` today, so that is a foundation change. The default credential chain picks the role up with no code change.
- **Rules.** A Factorial role reading the whole artefact store changes the write-only rule in `CLAUDE.md`, and a Fargate service for something that could be serverless needs an exception to "serverless first" recorded there.
- **Infrastructure.** An ECR repository (foundation), the image build in the deploy workflow, and an ALB and a Fargate service in `templates/dashboard.yml`, in the VPC the invoker uses. One server process holding the live subscriptions suits a long-running container.

None of this is in place: today no rule in `CLAUDE.md` changes, because a person reads with their own credentials and the artefact store stays write-only for every role Factorial owns.
