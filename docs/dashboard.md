# The command centre

A live, read-only operations console for one reviewer (#57, with #58 and #59 to follow). It is a Next.js app in `packages/dashboard`, run on the reviewer's own machine with their own AWS credentials. It deploys nothing and needs no foundation change. `docs/mockups/command-centre.html` is the specification for its layout and interaction: change both together.

## Running it

```sh
npm ci
AWS_PROFILE=<your profile> npm run dashboard
```

It builds the app on first run, starts it on `127.0.0.1:4757` and prints a URL with a token that is new on every start. Open that URL; nothing is served without it. `npm run dashboard -- --dev` runs the development server instead.

| Variable | Default |
|---|---|
| `DASHBOARD_PORT` | `4757` |
| `FACTORIAL_LIVE_HTTP_DOMAIN`, `FACTORIAL_ARTEFACT_BUCKET`, `FACTORIAL_STATE_MACHINE_ARN` | the `factorial-orchestration` stack's outputs `LiveHttpDomain`, `WorkArtefactsBucketName`, `WorkStateMachineArn`, as `scripts/tail-run.ts` finds them |
| `FACTORIAL_WORK_ITEMS_TABLE`, `FACTORIAL_THREADS_TABLE` | the stack's `WorkItemsTableName` and `ThreadsTableName`, else `factorial-work-items` and `factorial-threads` |
| `FACTORIAL_REPOSITORY` | `JamieGeddes/factorial`, where `FactorialVersion` is a commit |

Credentials come from the AWS SDK's default chain (`AWS_PROFILE`, SSO, environment variables). Region `eu-west-1`.

## The access it needs

An administrator profile works. A read-only identity needs exactly this, which is also the policy for the Fargate task role described below (replace `<account id>`, and take the two AppSync ARNs from the stack's outputs `LiveApiArn` and `LiveNamespaceArn`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Ledger", "Effect": "Allow", "Action": ["dynamodb:Scan", "dynamodb:GetItem"], "Resource": ["arn:aws:dynamodb:eu-west-1:<account id>:table/factorial-work-items", "arn:aws:dynamodb:eu-west-1:<account id>:table/factorial-threads"] },
    { "Sid": "ArtefactList", "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::factorial-work-artefacts-<account id>" },
    { "Sid": "ArtefactRead", "Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::factorial-work-artefacts-<account id>/*" },
    { "Sid": "Stacks", "Effect": "Allow", "Action": "cloudformation:DescribeStacks", "Resource": ["arn:aws:cloudformation:eu-west-1:<account id>:stack/factorial-orchestration/*", "arn:aws:cloudformation:eu-west-1:<account id>:stack/factorial-agent/*"] },
    { "Sid": "RuntimeVersions", "Effect": "Allow", "Action": "bedrock-agentcore:GetAgentRuntimeEndpoint", "Resource": "arn:aws:bedrock-agentcore:eu-west-1:<account id>:runtime/factorial_*" },
    { "Sid": "Alarms", "Effect": "Allow", "Action": "cloudwatch:DescribeAlarms", "Resource": "arn:aws:cloudwatch:eu-west-1:<account id>:alarm:factorial-*" },
    { "Sid": "BusRate", "Effect": "Allow", "Action": "cloudwatch:GetMetricData", "Resource": "*" },
    { "Sid": "LiveConnect", "Effect": "Allow", "Action": "appsync:EventConnect", "Resource": "<LiveApiArn>" },
    { "Sid": "LiveSubscribe", "Effect": "Allow", "Action": "appsync:EventSubscribe", "Resource": "<LiveNamespaceArn>" }
  ]
}
```

`cloudwatch:GetMetricData` takes no resource. The bucket is encrypted with S3-managed keys, so no KMS permission is needed. The command centre reads no GitHub API: every GitHub link is built from the ledger's repository fields.

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

- **Server-only modules** (`import 'server-only'`) in `src/server/` hold all AWS access, one per source: `ledger.ts`, `threads.ts`, `artefacts.ts`, `live.ts` (with `live-connection.ts`), `stacks.ts`, `runtimes.ts`, `cloudwatch.ts`. Route handlers call them through `handlers.ts`; nothing else touches an SDK. `services.ts` builds them once per process.
- **Caching**, in memory only: a finished item's artefacts and every catch-up chunk are kept for the life of the process (256 MiB in all); ledger and thread scans for 5 seconds; stack outputs and Runtime versions for 60 seconds; CloudWatch for 30 seconds. Nothing is written to disk.
- **Browser bundles** import nothing from `src/server/` and only `@factorial/live/channels` from `@factorial/live`, never `sign.ts` and the Node credential chain; a test checks it. The ledger types in `src/lib/records.ts` mirror `@factorial/progress` rather than import it, because that module brings ajv and the contract schema.
- **Tests** run on the source under `node --test`, with `test/register.ts` compiling `.tsx` through esbuild and stubbing `server-only`. Route handlers and server modules are tested with stubbed AWS clients.

### Data routes

All `GET` and JSON unless stated; each returns exactly what its view needs.

| Route | Returns |
|---|---|
| `/api/work-items?filter=&source=&q=&limit=&cursor=` | The Work items view's rows, running and waiting first, then newest first; the source types the ledger holds; running and waiting counts. `filter` is `all`, `running`, `waiting`, `finished`, `attention` or `refused`. |
| `/api/work-items/{id}` | The ledger row, its thread and a listing of every object under `<id>/`. |
| `/api/work-items/{id}/artefacts/{key}` | One object under `<id>/`, `key` relative to it: no `..`, no other item. A finished item's is read whole and kept; a running item's is streamed. |
| `/api/running` | Items with no `result` yet, created since #165 (`RESULT_SINCE` in `src/lib/status.ts`), with their `live` record. |
| `/api/status` | The status bar: the live version, each Runtime's `live` version, the bus rate, the alarms and the running counts. |
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
| Work items: every column | The ledger row (`workItem`, `status`, `result`, `route`, `refusedReason`, `branch`, `prNumber`, `savedWork`, `stages`, `live`, `reviewVerdict`, `reviewScores`, `attempt`, `createdAt`, `endedAt`) and its thread's `outcome` (merged or closed). Cost sums `stages.*.run.costUsd`, plus `live.costUsd` for a run not yet recorded. Refreshed on every message on `/factorial/work-items`, and every 20 seconds. |
| Work item detail | The row, its thread and the artefact listing. Rows open it until #58 adds the Run & transcript view. The header shows an `<n> build rounds` tag (`buildRounds`) when an item took more than one round; the Stages table shows under each stage with a `run` one line of runtime, turns, tool calls and stop reason (`runLine`), the stop reason amber for an incomplete run and red for a failed one. All from the same row, no extra call; the text is sanitised as untrusted. |
| Overview, Run & transcript | Not set up: #58. |
| Metrics & cost, Health | Not set up: #59. |

**The status mapping** (`statusPill` in `src/lib/status.ts`) is used everywhere. A turn has ended once its row has a `result`; a row created before #165 reached `main` never got one, so it has ended whatever it holds and its `status` stands in for the result. A running item in Build or Review reads `building` or `reviewing` (with the round above 1), in Test `testing` (styled as waiting: no agent in session), in any other stage the stage's name; `failed` with saved work reads `incomplete` and names the branch; `refused` carries its code and reason. A running item whose `live.at` is more than a minute old is stale: its invoker has stopped, and it appears under Needs attention.

## Intended architecture (later, not this work)

The command centre is expected to move to Fargate, like the other apps its owner runs: the same Next.js server built with `output: 'standalone'` into an image. What would change then:

- **Sign-in.** `src/server/guard.ts` and `src/proxy.ts` are replaced by real sign-in: the ALB's OIDC authentication, or middleware against the chosen identity provider.
- **Credentials.** A `factorial-dashboard` task role replaces the reviewer's profile, with the policy above. It holds `appsync:EventConnect` and `appsync:EventSubscribe`, and the runtime permissions boundary allows only `appsync:EventPublish` today, so that is a foundation change. The default credential chain picks the role up with no code change.
- **Rules.** A Factorial role reading the whole artefact store changes the write-only rule in `CLAUDE.md`, and a Fargate service for something that could be serverless needs an exception to "serverless first" recorded there.
- **Infrastructure.** An ECR repository (foundation), the image build in the deploy workflow, and an ALB and a Fargate service in `templates/dashboard.yml`, in the VPC the invoker uses. One server process holding the live subscriptions suits a long-running container.

None of this is in place: today no rule in `CLAUDE.md` changes, because a person reads with their own credentials and the artefact store stays write-only for every role Factorial owns.
