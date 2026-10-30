# The run contract

A run is one agent role's session on its AgentCore Runtime: the host process in the container runs the agent loop (the harness) against the role's model, and the invoker reads what happened. This contract is everything between the two: the invocation bodies, the stream of run events and the status reply. The invoker reads nothing else, so a different harness, or a model from another provider, changes the host on the Runtime and leaves the invoker, the state machine and the records as they are.

Today the only host is `packages/agent-runtime`, running pi with Claude on Amazon Bedrock; its adapter (`src/pi/events.ts`) is the one place pi's events are read, and everything that touches pi is in `src/pi/`. It ran the Claude Agent SDK until 2026-10-30 (`docs/pi-plan.md`); the contract did not change. The contract is internal to Factorial, not part of the `WorkItem` API, but the host and the invoker deploy at different moments, so it is versioned like the others. The canonical definitions are the JSON Schemas in `v1/`; `@factorial/run` validates against those files.

## Protocol

`POST /invocations` on the role's Runtime, with the `live` qualifier, takes one of three bodies (`v1/invocation.schema.json`):

| Action | Body | Reply |
|---|---|---|
| `run` | `contract` (the version the caller reads), `prompt`, `round`, optional `workItemId` and `attempt` | The session's one run, as server-sent events. 400 unless `contract` is one the host speaks; 409 if the session has had a run. |
| `attach` | optional `after` (default 0) | The events after `after`, replayed from the host's transcript, then live until the run ends. 409 if no run has started. |
| `status` | | `v1/run-status.schema.json`: `contract`, `state` (`idle`, `running`, `finished`, `failed`), `events` (how many) and, once the run has ended, `ended` (its `run.ended`). |

Each server-sent event is `id: <n>` and `data: <one run event as JSON>`, numbered from 1 without gaps, so a caller that loses the stream re-attaches from the last number it has. The model, limits and tools are the Runtime version's; a host ignores any other field in the body.

## Events

`v1/run-event.schema.json`. Every event has a `type`. `run.started` is always first and `run.ended` always last, exactly once.

| Type | Carries |
|---|---|
| `run.started` | `contract`, the `harness` (`name`, `version`), the `role`, the `models` the version names (each with `purpose`, `provider` and `id`) and the `tools`. |
| `model.call` | One model call's `usage`, once however the harness splits the response; optional `model`, and `exact: false` when the output count is a lower bound. |
| `model.retry` | A retried model call: `attempt`, and optionally `maxRetries`, `delayMs`, `status` and `error`. |
| `text`, `reasoning` | The model's text, or its visible reasoning. |
| `tool.call`, `tool.result` | A tool call (`callId`, `tool`, `input`) and its result (`callId`, `content` as text, `isError`). |
| `subagent.started`, `subagent.ended` | A subagent's `agentId` and `agentType`; at its end the harness's `durationMs`, `toolCalls` and `finalContextTokens`. |
| `context.compacted` | The harness compacted the context: `trigger`, `tokensBefore`, `tokensAfter`. |
| `harness` | A native message no other type carries, kept for the transcript (`name`, `message`). Never interpreted. |
| `run.ended` | `outcome`, `reason`, and what the harness reported: `detail` (its own code), `errors`, `turns`, `durationMs`, `cost`, `models` (totals per model, subagents included) and `deniedToolCalls`. |

Events from a subagent carry its `agentId`; events without one are the role's own loop.

**Models.** A model is `{ provider, id }`: `provider` is how it is reached (`bedrock`, `anthropic`, `vertex`, `openai`, ...), `id` what that provider calls it. Nothing in the contract assumes a vendor.

**Usage.** `inputTokens` is the whole prompt, cache reads and writes included, as `usage.json` has always counted it. `cacheReadInputTokens`, `cacheWriteInputTokens` and `reasoningTokens` (inside `outputTokens`) are subsets, absent when a provider does not report them. `run.ended`'s `models` are the run's totals when present; otherwise the invoker sums the `model.call` events.

**Cost.** Optional, in US dollars, with its `basis`. `harness-estimate` is the harness's figure at list prices, not a bill.

**Outcome and reason.** The outcome is closed and decides what happens next: `complete` (the role finished), `incomplete` (a turn, budget or time limit stopped it: the builder's rounds path) or `failed`. The reason says why, and is open so that a new harness can add one; a consumer that does not know a reason goes by the outcome. The known reasons:

| Reason | Outcome | When |
|---|---|---|
| `completed` | complete | The role finished. |
| `max_turns` | incomplete | The version's turn limit. |
| `max_budget` | incomplete | The version's budget. |
| `max_duration` | incomplete | The host's time limit, unless the run had already completed. |
| `model_error` | failed | The model's provider failed and the harness gave up. |
| `harness_error` | failed | The harness failed, or ended in a way the host does not recognise. |
| `host_error` | failed | The host failed outside the harness, or the harness ended without a result. |

The invoker adds its own stop reasons in the ledger and `usage.json` when it cannot use `run.ended`: `contract_mismatch`, `no_end`, `outcome_mismatch` (the stream and the status disagree, or a known reason contradicts its outcome) and `interrupted`.

## Writing a host

A host for another harness or provider implements the protocol above, emits `run.started` first and one `run.ended` last, and maps its harness's messages to events in an adapter. It keeps what the Runtime contract and `docs/security.md` require of every host: it runs as root and the model as the `agent` user, takes its model, limits and tools from the Runtime version's environment, never from a request, and declares `FACTORIAL_RUN_CONTRACT` on the version. Nothing else changes for the orchestrator.

## Version skew

The invoker deploys with the orchestration stack and the host when the deploy workflow promotes the Runtime `live` endpoints, so for a time either side may be newer. Three checks make a mismatch fail before any model call rather than part-way through a run:

1. Each Runtime version declares the contract its host speaks in `FACTORIAL_RUN_CONTRACT`, and the host refuses to start unless it matches. The invoker reads the declaration from the version serving `live` before it invokes.
2. The `run` body names the contract the invoker reads, and a host that does not speak it answers 400.
3. The invoker requires the first event to be a `run.started` for its contract.

A run that crosses the deploy of a breaking change fails cleanly and is relabelled.

## Changing the contract

1. Change the schemas, the examples and the tests in `packages/run`, the host's adapter and the invoker in one PR.
2. **Additive changes stay in `v1`:** a new optional field, a new event type or a new reason. Consumers ignore event types and fields they do not know and decide by the outcome, so an older invoker reads a newer host's events.
3. **Breaking changes** create `v2/` alongside `v1/` and increment the contract number in `@factorial/run`, `FACTORIAL_RUN_CONTRACT` and the `run` body together. A host may speak more than one version while invokers move over.

## Change log

- **2026-10: v1.** The invocation bodies, run events and status, replacing the Claude Agent SDK's raw messages on the stream.
