# Implementation plan: pi for every role

**Date:** 2026-10-30. **Status:** decided 2026-10-29; phases 0 and 1 done. **Starting point:** `main` after #196, with the builder on pi and the reviewer on the Claude Agent SDK.

This plan moves every role to pi (`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`, MIT, pinned at 1.4.0) and removes the Claude Agent SDK. Spike #181 justified it: see `docs/harness-vs-runtime.md`, **pi on AgentCore Runtime** and **pi spike results**. The reason is flexibility. pi's loop runs in Factorial's host process, where Factorial can read, extend and patch it, and other models on Bedrock become a configuration change.

The move is made one role at a time, like `docs/agent-sdk-plan.md`. Until the last phase, `FACTORIAL_HARNESS` on a Runtime version is the rollback. Nothing outside the agent host changes: the run contract (`contracts/run/v1/`), the invoker, the state machine and the records already treat the harness as the Runtime version's business.

## 1. Target shape

- Both Runtimes run the same image and host, with pi as the only harness. The loop, the role's policy (one host extension), subagents (child sessions behind the `task` tool) and the turn and budget limits run in the root host. Every tool that runs a command or touches a file runs as the `agent` user through `setpriv` and the file helper (`docs/security.md` §9.2b).
- The roles' definitions stay in `packages/agent-runtime/src/roles.ts`, defined once. `src/pi/` is the only mapping of them.
- The image carries no Claude Code binary, no `claude-as-agent` wrapper and no SDK package.
- Models, limits, IAM and the run contract are unchanged. Another Bedrock model is a later item of its own.

## 2. Phases

### Phase 0: close the spike (done, #196)

- Security probe in the real image (`scripts/pi-security-probe.ts`): 22 of 22 checks held. It found AWS credential variables reaching pi's shell, which are now removed.
- Limits: `pi/loop.test.ts` drives pi's real loop at the turn limit, the budget and a host abort.
- Fixes found in run (b):
  - pi's turn count and detail at a limit;
  - the failure comment's commit count over every round;
  - the commit message for a round that reaches its limit.
- Input at 1.46× the SDK's was accepted: it was mostly the plan subagent, which the SDK baseline did not have.
- Results written up in `docs/harness-vs-runtime.md`; #181 closed.

### Phase 1: record the decision (this document's pull request)

- `CLAUDE.md`: **Target architecture** names pi; **Current stage** and the **Language** and **Agent roles** conventions say where each role is.
- `docs/security.md` §9: the in-session enforcement decision is kept with pi, and §9.2b becomes the main list once the SDK host goes.
- This plan, and a tracking issue with one item per remaining phase.

### Phase 2: the builder on pi for good

- **`templates/20-agent.yml`:** the builder's harness comment changes from "for the spike's runs" to permanent. `FACTORIAL_EFFORT: high` stays unless the figures below argue otherwise.
- **Watch about 10 items,** including reworks and at least one that is not a refactor. For each, from the ledger and `build/usage.json`:
  - outcome and rounds;
  - turns and model calls;
  - input, cache share and cost, with the plan subagent's share;
  - the review verdict;
  - whether tests passed first time.
  
  Compare with the SDK builds of 2026-10-25 to 2026-10-28.
- **Exit:** no regression against the SDK figures that the item mix does not explain.

### Phase 3: the reviewer on pi

- **`FACTORIAL_HARNESS: pi` on the reviewer's Runtime version.** Its definition is already shared: read tools, writes only to `/workspace/review.json`, no subagents, no web search. Its policy's shell rules and the review second pass are harness-neutral (`roles.ts`).
- **Before switching, run the security probe with the reviewer's role** (`HOST_ROLES.reviewer`). Its write rule and shell rules differ from the builder's.
- **Effort:** the reviewer has none set today, which leaves Claude Code's default. Choose pi's explicitly.
- **Watch about 10 reviews.** Verdicts and scores should be in line with the SDK reviewer's, and above all there should be no approval of a change that tests or a human then find wrong.
- **Exit:** the above, and no reviewer run that fails for a harness reason.

### Phase 4: remove the SDK

One pull request, deployed as one new Runtime version for both roles. Phase 3 must be live first, because this removes the harness the reviewer runs on until then.

- **Tag first:** `main` is tagged `stage-1-claude-sdk-final` before the pull request merges, as `stage-0-harness` and `stage-1-agent-sdk` were.
- **Delete:**
  - `packages/agent-runtime/src/claude-sdk/` and its tests;
  - the harness choice (`src/harness.ts` keeps only the interface, `index.ts` starts pi, and `config.ts` and both template blocks drop `FACTORIAL_HARNESS`);
  - `@anthropic-ai/claude-agent-sdk` from `packages/agent-runtime/package.json`, `agent-runtime/package.json` and the lockfiles.
- **Image (`agent-runtime/Dockerfile`):**
  - remove the SDK install, the removal of its musl binary, `claude-as-agent` and the `CLAUDE_CONFIG_DIR` comment;
  - check whether pi still needs installing beside the bundle;
  - the probe and the image's `rg` wrapper stay.
- **Move what pi borrows from the SDK side into `src/pi/`:** the environment allow-list (`PASSED_THROUGH`) and anything else `src/pi/` imports from `src/claude-sdk/`.
- **The run contract stays v1.** The harness name is a value. Update the examples and comments that name the SDK:
  - `contracts/run/`;
  - `packages/run`;
  - `packages/orchestration/src/lib/incomplete.ts`;
  - `packages/invoker/src/run-events.test.ts`.
- **Docs:**
  - `README.md`, `docs/current-stage.md`, `docs/system-diagram.md`;
  - `docs/session-boundaries.*`, including `sdk-host.svg`;
  - `docs/target-state-architecture.md`, `docs/bootstrap.md`;
  - `docs/security.md`: §9.2 folds into §9.2b, and the WebFetch note about Claude Code's `api.anthropic.com` check goes;
  - `CLAUDE.md`'s **Current stage** and conventions lose their "until it moves" clauses.
  
  `docs/agent-sdk-plan.md` becomes history.
- **A candidate Factorial work item:** a deletion with clear acceptance, reviewed by the pi reviewer.

## 3. Pull requests, in order

1. #196: phase 0 (merged).
2. Phase 1: `CLAUDE.md`, `docs/security.md` §9, this plan.
3. Phase 2: the builder's template comment, then the figures after about 10 items, recorded here.
4. Phase 3: the reviewer probe and `FACTORIAL_HARNESS: pi` on the reviewer, then its figures.
5. Phase 4: the SDK's removal, after the tag.

## 4. Standing rules

- **Pinned exactly.** pi is pinned at an exact version. `pi/bedrock.ts` relies on its Bedrock provider's shape and checks that shape at startup. Every pi upgrade is its own reviewed pull request, with `npm run ci`, the probe in the image, and one labelled item before the next upgrade.
- **The probe runs on every change to `src/pi/` that touches tools, the environment or the resource loader.** Run it on the image that change builds.

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| pi is a small project; a release breaks or stalls | Exact pin; upgrades only by pull request with the checks above; the host owns the code it relies on (`src/pi/`) and can patch around pi |
| More of the security surface is Factorial's code | §9.2b's mitigations; the probe in the image; the outer boundaries (execution role, clean room, tested-head check) do not depend on the loop |
| The reviewer judges differently on pi | Phase 3 watches verdicts against the SDK reviewer's before phase 4 removes the fallback |
| Cost per item rises | Phase 2's figures, with the plan subagent's share shown separately |

## 6. Rollback

- **Phases 2 and 3:** set `FACTORIAL_HARNESS` back to `claude-agent-sdk` on the role's Runtime block. It is a new Runtime version, deployed and promoted as usual.
- **After phase 4:** revert the removal pull request, or rebuild from `stage-1-claude-sdk-final`.
